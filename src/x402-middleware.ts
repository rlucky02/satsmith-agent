import type { Context, Next } from "hono";

export type TokenType = "STX" | "sBTC" | "USDCx";

type Network = "mainnet" | "testnet";

type TokenContract = {
  address: string;
  name: string;
};

type PaymentRequirement = {
  maxAmountRequired: string;
  resource: string;
  payTo: string;
  network: Network;
  nonce: string;
  expiresAt: string;
  tokenType: TokenType;
  tokenContract?: TokenContract;
};

type SettleResult = {
  isValid: boolean;
  txId?: string;
  sender?: string;
  senderAddress?: string;
  sender_address?: string;
  error?: string;
  reason?: string;
  validationError?: string;
};

export type X402Context = {
  payerAddress: string;
  settleResult: SettleResult;
  signedTx: string;
};

type Bindings = {
  RECIPIENT_ADDRESS: string;
  NETWORK: string;
  RELAY_URL: string;
};

type Variables = {
  x402?: X402Context;
};

type X402Config = {
  amount: string;
  tokenType: TokenType;
};

const TOKEN_CONTRACTS: Record<Network, Record<"sBTC" | "USDCx", TokenContract>> = {
  mainnet: {
    sBTC: { address: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4", name: "sbtc-token" },
    USDCx: { address: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE", name: "usdcx" },
  },
  testnet: {
    sBTC: { address: "ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT", name: "sbtc-token" },
    USDCx: { address: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM", name: "usdcx" },
  },
};

function classifyError(rawError: unknown, settleResult?: SettleResult) {
  const combined = [
    String(rawError ?? ""),
    settleResult?.error ?? "",
    settleResult?.reason ?? "",
    settleResult?.validationError ?? "",
  ].join(" ").toLowerCase();

  if (/(network|fetch|timeout|socket)/.test(combined)) {
    return { code: "NETWORK_ERROR", status: 502, message: "Network error while verifying payment", retryAfter: 5 };
  }
  if (/(unavailable|503|relay)/.test(combined)) {
    return { code: "RELAY_UNAVAILABLE", status: 503, message: "Payment relay is temporarily unavailable", retryAfter: 30 };
  }
  if (/(insufficient|balance)/.test(combined)) {
    return { code: "INSUFFICIENT_FUNDS", status: 402, message: "Insufficient funds for payment" };
  }
  if (/(expired|nonce)/.test(combined)) {
    return { code: "PAYMENT_EXPIRED", status: 402, message: "Payment expired, sign a fresh payment" };
  }
  if (/(invalid|signature)/.test(combined)) {
    return { code: "PAYMENT_INVALID", status: 400, message: "Invalid payment payload" };
  }
  if (/(low|minimum|amount)/.test(combined)) {
    return { code: "AMOUNT_TOO_LOW", status: 402, message: "Payment amount is below the minimum required" };
  }
  return { code: "UNKNOWN_ERROR", status: 500, message: "Payment processing error", retryAfter: 5 };
}

function resolveTokenType(headerValue: string | undefined, fallback: TokenType): TokenType {
  const normalized = String(headerValue ?? "").trim().toUpperCase();
  if (normalized === "STX") return "STX";
  if (normalized === "SBTC") return "sBTC";
  if (normalized === "USDCX") return "USDCx";
  return fallback;
}

export function x402Middleware(config: X402Config) {
  return async (c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) => {
    const network = (c.env.NETWORK || "mainnet") as Network;
    const relayUrl = c.env.RELAY_URL || (network === "mainnet" ? "https://x402-relay.aibtc.com" : "https://x402-relay.aibtc.dev");
    const recipientAddress = c.env.RECIPIENT_ADDRESS;
    const tokenType = resolveTokenType(c.req.header("X-PAYMENT-TOKEN-TYPE"), config.tokenType);
    const signedTx = c.req.header("X-PAYMENT");

    if (!recipientAddress) {
      return c.json({ error: "Missing RECIPIENT_ADDRESS binding" }, 503);
    }

    if (!signedTx) {
      const requirement: PaymentRequirement = {
        maxAmountRequired: config.amount,
        resource: c.req.path,
        payTo: recipientAddress,
        network,
        nonce: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        tokenType,
      };

      if (tokenType === "sBTC" || tokenType === "USDCx") {
        requirement.tokenContract = TOKEN_CONTRACTS[network][tokenType];
      }

      c.header("X-PAYMENT-REQUIRED", JSON.stringify(requirement));
      return c.json(requirement, 402);
    }

    let settleResult: SettleResult;
    try {
      const response = await fetch(`${relayUrl}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signedTx,
          expectedRecipient: recipientAddress,
          minAmount: config.amount,
          tokenType,
          network,
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        throw new Error(`relay ${response.status}: ${text}`);
      }

      settleResult = await response.json<SettleResult>();
    } catch (error) {
      const classified = classifyError(error);
      if (classified.retryAfter) {
        c.header("Retry-After", String(classified.retryAfter));
      }
      return c.json(
        {
          error: classified.message,
          code: classified.code,
          tokenType,
          resource: c.req.path,
        },
        classified.status as 400 | 402 | 500 | 502 | 503,
      );
    }

    if (!settleResult.isValid) {
      const classified = classifyError(settleResult.validationError || settleResult.error || "invalid", settleResult);
      if (classified.retryAfter) {
        c.header("Retry-After", String(classified.retryAfter));
      }
      return c.json(
        {
          error: classified.message,
          code: classified.code,
          tokenType,
          resource: c.req.path,
          details: {
            relayError: settleResult.error,
            relayReason: settleResult.reason,
            validationError: settleResult.validationError,
          },
        },
        classified.status as 400 | 402 | 500 | 502 | 503,
      );
    }

    const payerAddress = settleResult.senderAddress || settleResult.sender_address || settleResult.sender || "unknown";
    c.set("x402", {
      payerAddress,
      settleResult,
      signedTx,
    });
    c.header("X-PAYMENT-RESPONSE", JSON.stringify(settleResult));
    c.header("X-PAYER-ADDRESS", payerAddress);

    await next();
  };
}
