import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { x402Middleware } from "./x402-middleware";
import type { X402Context } from "./x402-middleware";

type Bindings = {
  RECIPIENT_ADDRESS: string;
  NETWORK: string;
  RELAY_URL: string;
};

type Variables = {
  x402?: X402Context;
};

type Project = {
  id: string | null;
  title: string;
  description: string;
  githubUrl: string | null;
  status: string;
  claimedBy: string | null;
  founder: string | null;
  deliverableCount: number;
  openGoals: number;
  mentions: number;
  reputationAverage: number;
  reputationCount: number;
  updatedAt: string | null;
};

type LeaderboardEntry = {
  displayName: string;
  description: string;
  score: number;
};

type ActivitySummary = {
  totalAgents: number;
  activeAgents: number;
  totalMessages: number;
  totalSatsTransacted: number;
};

type BountySummary = {
  openBounties: number;
  publicBountyPayoutSats: number;
};

type MarketSnapshot = {
  generatedAt: string;
  activity: ActivitySummary;
  leaderboard: LeaderboardEntry[];
  projects: Project[];
  bounty: BountySummary;
};

type RankedProject = {
  id: string | null;
  title: string;
  status: string;
  score: number;
  founder: string | null;
  githubUrl: string | null;
  openGoals: number;
  deliverables: number;
  reason: string;
  angle: string;
  firstMove: string;
};

type AuthDebugInput = {
  address?: string;
  chain?: string;
  message?: string;
  signature?: string;
  flow?: string;
  context?: string;
};

type CounterpartyInput = {
  target?: string;
  projectId?: string;
  githubUrl?: string;
  founder?: string;
};

type GitHubRepoSummary = {
  fullName: string;
  description: string;
  stars: number;
  forks: number;
  openIssues: number;
  archived: boolean;
  pushedAt: string | null;
  updatedAt: string | null;
  defaultBranch: string | null;
  homepage: string | null;
  license: string | null;
};

const SERVICE_NAME = "satsmith-intelligence-suite";
const SERVICE_VERSION = "0.4.0";
const SERVICE_PRICE_SATS = "100";
const FREE_PREVIEW_LIMIT = 3;
const ACTIVITY_URL = "https://aibtc.com/api/activity";
const LEADERBOARD_URL = "https://aibtc.com/api/leaderboard?limit=10";
const PROJECTS_URL = "https://aibtc-projects.pages.dev/api/items";
const BOUNTY_STATS_URL = "https://bounty.drx4.xyz/api/stats";
const RELEVANCE_PATTERN = /(bitcoin|stacks|x402|agent|api|tool|skill|audit|review|dashboard|infra|oracle|sign|verify|payment|relay|wallet)/i;
const AIBTC_MESSAGE_PATTERNS = [
  {
    kind: "registration",
    exact: "Bitcoin will be the currency of AIs",
    hint: "Registration signatures must match the exact static phrase.",
  },
  {
    kind: "heartbeat",
    prefix: "AIBTC Check-In | ",
    hint: "Heartbeat messages need an ISO 8601 timestamp close to server time.",
  },
  {
    kind: "inbox-read",
    prefix: "Inbox Read | ",
    hint: "Inbox read signatures require the exact message id after the separator.",
  },
  {
    kind: "inbox-reply",
    prefix: "Inbox Reply | ",
    hint: "Inbox reply signatures require exact separators and reply text.",
  },
] as const;

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization", "X-PAYMENT", "X-PAYMENT-TOKEN-TYPE"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    exposeHeaders: ["X-PAYMENT-RESPONSE", "X-PAYER-ADDRESS", "X-PAYMENT-REQUIRED"],
  }),
);

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function short(text: string, max = 180): string {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 3)}...`;
}

function inferAddressProfile(address: string) {
  const value = String(address ?? "").trim();
  if (!value) {
    return {
      kind: "unknown",
      network: "unknown",
      notes: ["Address is missing."],
    };
  }

  if (/^(SP|SM)/.test(value)) {
    return {
      kind: "stacks",
      network: "mainnet",
      notes: ["Stacks mainnet address detected."],
    };
  }

  if (/^(ST|SN)/.test(value)) {
    return {
      kind: "stacks",
      network: "testnet",
      notes: ["Stacks testnet address detected."],
    };
  }

  if (/^bc1p/i.test(value)) {
    return {
      kind: "bitcoin",
      network: "mainnet",
      notes: ["Taproot bitcoin address detected. Some wallet flows use BIP-322 and can hide the pubkey until challenged."],
    };
  }

  if (/^bc1q/i.test(value)) {
    return {
      kind: "bitcoin",
      network: "mainnet",
      notes: ["SegWit bitcoin address detected. Message verification often depends on the wallet's signing mode."],
    };
  }

  if (/^[13]/.test(value)) {
    return {
      kind: "bitcoin",
      network: "mainnet",
      notes: ["Legacy bitcoin mainnet address detected."],
    };
  }

  if (/^(tb1p|tb1q|m|n|2)/i.test(value)) {
    return {
      kind: "bitcoin",
      network: "testnet",
      notes: ["Bitcoin testnet address detected."],
    };
  }

  return {
    kind: "unknown",
    network: "unknown",
    notes: ["Address format is not recognized as a common BTC or STX format."],
  };
}

function detectAibtcMessage(message: string) {
  const raw = String(message ?? "");
  for (const pattern of AIBTC_MESSAGE_PATTERNS) {
    if ("exact" in pattern && raw === pattern.exact) {
      return {
        kind: pattern.kind,
        exactMatch: true,
        hint: pattern.hint,
      };
    }
    if ("prefix" in pattern && raw.startsWith(pattern.prefix)) {
      return {
        kind: pattern.kind,
        exactMatch: true,
        hint: pattern.hint,
      };
    }
  }

  const fuzzy = AIBTC_MESSAGE_PATTERNS.find((pattern) => {
    if ("exact" in pattern) {
      return raw.trim() === pattern.exact;
    }
    return raw.trim().startsWith(pattern.prefix);
  });

  return {
    kind: fuzzy?.kind ?? "custom",
    exactMatch: !fuzzy,
    hint: fuzzy?.hint ?? "Custom message detected.",
  };
}

function buildAuthDebug(body: AuthDebugInput) {
  const address = String(body.address ?? "").trim();
  const chain = String(body.chain ?? "").trim().toLowerCase();
  const message = String(body.message ?? "");
  const signature = String(body.signature ?? "").trim();
  const flow = String(body.flow ?? "").trim();
  const context = String(body.context ?? "").trim();
  const addressProfile = inferAddressProfile(address);
  const detectedMessage = detectAibtcMessage(message);
  const findings: Array<{ severity: "high" | "medium" | "low"; issue: string; detail: string }> = [];
  const nextActions: string[] = [];

  if (!address) {
    findings.push({
      severity: "high",
      issue: "Missing address",
      detail: "Provide the signer address so the debug flow can identify BTC vs STX rules.",
    });
  }

  if (!signature) {
    findings.push({
      severity: "high",
      issue: "Missing signature",
      detail: "Without a signature this route can only do format triage, not a real auth debug pass.",
    });
  } else if (signature.length < 40) {
    findings.push({
      severity: "medium",
      issue: "Suspiciously short signature",
      detail: "The supplied signature is shorter than most BTC/STX message signatures and may be truncated or copied incorrectly.",
    });
  }

  if (!message.trim()) {
    findings.push({
      severity: "high",
      issue: "Missing message",
      detail: "AIBTC auth depends on exact message text. Empty or partially copied messages fail verification.",
    });
  }

  if (message && message !== message.trim()) {
    findings.push({
      severity: "high",
      issue: "Leading or trailing whitespace",
      detail: "AIBTC signature checks are exact-string sensitive. Extra spaces or newlines commonly break auth.",
    });
  }

  if (chain && addressProfile.kind !== "unknown") {
    if (chain === "stx" && addressProfile.kind !== "stacks") {
      findings.push({
        severity: "high",
        issue: "Chain/address mismatch",
        detail: "The request says STX but the address looks like BTC.",
      });
    }
    if (chain === "btc" && addressProfile.kind !== "bitcoin") {
      findings.push({
        severity: "high",
        issue: "Chain/address mismatch",
        detail: "The request says BTC but the address looks like STX.",
      });
    }
  }

  if (detectedMessage.kind === "registration" && message !== "Bitcoin will be the currency of AIs") {
    findings.push({
      severity: "high",
      issue: "Registration phrase mismatch",
      detail: "Registration only verifies against the exact phrase `Bitcoin will be the currency of AIs`.",
    });
  }

  if (detectedMessage.kind === "heartbeat") {
    const timestamp = message.split("|")[1]?.trim() ?? "";
    const parsed = Date.parse(timestamp);
    if (!timestamp) {
      findings.push({
        severity: "high",
        issue: "Missing heartbeat timestamp",
        detail: "Heartbeat signatures need `AIBTC Check-In | <ISO timestamp>`.",
      });
    } else if (Number.isNaN(parsed)) {
      findings.push({
        severity: "high",
        issue: "Invalid heartbeat timestamp",
        detail: "Heartbeat timestamps should be valid ISO 8601 values, usually with a trailing `Z`.",
      });
    } else {
      const driftMinutes = Math.abs(Date.now() - parsed) / 60_000;
      if (driftMinutes > 5) {
        findings.push({
          severity: "high",
          issue: "Heartbeat timestamp drift",
          detail: `Current heartbeat timestamp is ${driftMinutes.toFixed(1)} minutes away from server time. AIBTC heartbeat windows are tight.`,
        });
      }
    }
  }

  if (detectedMessage.kind === "inbox-read" && !/^Inbox Read \| [A-Za-z0-9-]+$/.test(message.trim())) {
    findings.push({
      severity: "medium",
      issue: "Inbox read format risk",
      detail: "Expected `Inbox Read | <messageId>` with exact spacing.",
    });
  }

  if (detectedMessage.kind === "inbox-reply" && message.trim().split("|").length < 3) {
    findings.push({
      severity: "medium",
      issue: "Inbox reply format risk",
      detail: "Expected `Inbox Reply | <messageId> | <reply text>` with both separators preserved.",
    });
  }

  if (addressProfile.kind === "bitcoin" && /^bc1[qp]/i.test(address)) {
    findings.push({
      severity: "low",
      issue: "Modern BTC signing caveat",
      detail: "bc1q/bc1p wallets often use BIP-322 style message signing. If registration complains about missing pubkey, a challenge flow or nostr pubkey may be required.",
    });
  }

  nextActions.push("Re-sign the exact message from the same wallet account without editing whitespace.");
  if (detectedMessage.kind === "heartbeat") {
    nextActions.push("Generate a fresh ISO 8601 timestamp immediately before signing the heartbeat message.");
  }
  if (addressProfile.kind === "bitcoin") {
    nextActions.push("Confirm whether the wallet uses legacy signed messages or BIP-322, and keep the address/signing mode consistent.");
  }
  if (addressProfile.kind === "stacks") {
    nextActions.push("Verify the STX address matches the chain you are sending to AIBTC and that the same key signed the message.");
  }
  if (!flow) {
    nextActions.push("State whether this is registration, heartbeat, inbox-read, inbox-reply, or x402 auth for a more targeted debug pass.");
  }

  return {
    generatedAt: new Date().toISOString(),
    input: {
      chain: chain || null,
      address: address || null,
      flow: flow || null,
      context: context || null,
      messagePreview: short(message, 140),
      signaturePresent: Boolean(signature),
    },
    classification: {
      addressKind: addressProfile.kind,
      addressNetwork: addressProfile.network,
      messageKind: detectedMessage.kind,
    },
    findings,
    notes: [...addressProfile.notes, detectedMessage.hint],
    nextActions: Array.from(new Set(nextActions)),
    escalation:
      findings.some((item) => item.severity === "high")
        ? "If the flow still fails after correcting the exact message and signer, escalate to a paid debug request with the full failing payload and expected outcome."
        : "The payload does not show an obvious fatal formatting problem. A deeper paid debug pass would focus on wallet signing mode, transport headers, or relay-side verification.",
  };
}

function normalizeGitHubRepoSlug(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }

  const match = raw.match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  if (match) {
    return `${match[1]}/${match[2].replace(/\.git$/i, "")}`;
  }

  if (/^[^/\s]+\/[^/\s]+$/.test(raw)) {
    return raw.replace(/\.git$/i, "");
  }

  return null;
}

function daysSince(value: string | null | undefined): number | null {
  const parsed = Date.parse(String(value ?? ""));
  if (Number.isNaN(parsed)) {
    return null;
  }
  return Math.floor((Date.now() - parsed) / 86_400_000);
}

async function fetchGitHubRepoSummary(githubUrl: string | null | undefined): Promise<GitHubRepoSummary | null> {
  const slug = normalizeGitHubRepoSlug(githubUrl);
  if (!slug) {
    return null;
  }

  const response = await fetch(`https://api.github.com/repos/${slug}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "satsmith-agent",
    },
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as {
    full_name?: string;
    description?: string;
    stargazers_count?: number;
    forks_count?: number;
    open_issues_count?: number;
    archived?: boolean;
    pushed_at?: string;
    updated_at?: string;
    default_branch?: string;
    homepage?: string;
    license?: { spdx_id?: string; name?: string } | null;
  };

  return {
    fullName: payload.full_name ?? slug,
    description: payload.description ?? "",
    stars: toNumber(payload.stargazers_count),
    forks: toNumber(payload.forks_count),
    openIssues: toNumber(payload.open_issues_count),
    archived: payload.archived === true,
    pushedAt: payload.pushed_at ?? null,
    updatedAt: payload.updated_at ?? null,
    defaultBranch: payload.default_branch ?? null,
    homepage: payload.homepage ?? null,
    license: payload.license?.spdx_id ?? payload.license?.name ?? null,
  };
}

function scoreCounterpartyCandidate(project: Project, input: CounterpartyInput) {
  let score = 0;
  const target = String(input.target ?? "").trim().toLowerCase();
  const founder = String(input.founder ?? "").trim().toLowerCase();
  const repoSlug = normalizeGitHubRepoSlug(input.githubUrl);
  const projectRepoSlug = normalizeGitHubRepoSlug(project.githubUrl);
  const searchable = `${project.title} ${project.description} ${project.githubUrl ?? ""} ${project.founder ?? ""} ${project.claimedBy ?? ""}`.toLowerCase();

  if (input.projectId && project.id === input.projectId) {
    score += 100;
  }
  if (repoSlug && projectRepoSlug === repoSlug) {
    score += 90;
  }
  if (founder && (project.founder?.toLowerCase().includes(founder) || project.claimedBy?.toLowerCase().includes(founder))) {
    score += 45;
  }
  if (target) {
    if (project.title.toLowerCase().includes(target)) score += 40;
    if (project.description.toLowerCase().includes(target)) score += 22;
    if ((project.founder ?? "").toLowerCase().includes(target)) score += 24;
    if ((project.claimedBy ?? "").toLowerCase().includes(target)) score += 18;
    if ((project.githubUrl ?? "").toLowerCase().includes(target)) score += 18;
  }

  if (!input.projectId && !repoSlug && !founder && !target) {
    score += scoreProject(project);
  }

  return score;
}

async function buildCounterpartyReport(snapshot: MarketSnapshot, input: CounterpartyInput) {
  const candidates = snapshot.projects
    .map((project) => ({ project, score: scoreCounterpartyCandidate(project, input) }))
    .sort((left, right) => right.score - left.score);
  const best = candidates[0];
  const matchedProject = best && best.score > 0 ? best.project : null;
  const repoSummary = await fetchGitHubRepoSummary(input.githubUrl ?? matchedProject?.githubUrl ?? null);
  const positives: string[] = [];
  const risks: string[] = [];
  let trustScore = 45;

  if (matchedProject?.founder || matchedProject?.claimedBy) {
    trustScore += 10;
    positives.push(`Project has a visible human/agent owner: ${matchedProject.founder ?? matchedProject.claimedBy}.`);
  } else if (matchedProject) {
    trustScore -= 8;
    risks.push("No visible founder or claimant is attached to the project entry.");
  }

  if (matchedProject) {
    if (matchedProject.deliverableCount >= 3) {
      trustScore += 14;
      positives.push(`Public proof exists: ${matchedProject.deliverableCount} deliverable(s) are visible on the project board.`);
    } else if (matchedProject.deliverableCount === 0) {
      trustScore -= 10;
      risks.push("Project has no visible public deliverables yet.");
    }

    if (matchedProject.openGoals === 0) {
      trustScore += 8;
      positives.push("No open project-board goals are visible.");
    } else if (matchedProject.openGoals >= 3) {
      trustScore -= 8;
      risks.push(`Project still shows ${matchedProject.openGoals} open goals, so execution may be behind plan.`);
    }

    if (matchedProject.reputationCount > 0) {
      const repBoost = Math.min(15, Math.round(matchedProject.reputationAverage * 3));
      trustScore += repBoost;
      positives.push(`Project has reputation data: ${matchedProject.reputationAverage.toFixed(1)} average across ${matchedProject.reputationCount} rating(s).`);
      if (matchedProject.reputationAverage < 3) {
        trustScore -= 10;
        risks.push("Reputation is present but weak, which reduces confidence.");
      }
    }

    if (matchedProject.mentions > 0) {
      trustScore += Math.min(8, matchedProject.mentions);
      positives.push(`Project is being discussed publicly (${matchedProject.mentions} mention(s)).`);
    }

    if (matchedProject.status === "done") {
      trustScore += 10;
      positives.push("Project board status is done.");
    } else if (matchedProject.status === "in-progress") {
      trustScore += 6;
      positives.push("Project is actively in progress.");
    } else if (matchedProject.status === "blocked") {
      trustScore -= 16;
      risks.push("Project is marked blocked on the public board.");
    }

    const projectAge = daysSince(matchedProject.updatedAt);
    if (projectAge !== null && projectAge <= 14) {
      trustScore += 8;
      positives.push(`Project board was updated recently (${projectAge} day(s) ago).`);
    } else if (projectAge !== null && projectAge > 45) {
      trustScore -= 10;
      risks.push(`Project board looks stale (${projectAge} day(s) since update).`);
    }
  }

  if (repoSummary) {
    if (repoSummary.archived) {
      trustScore -= 25;
      risks.push("GitHub repo is archived.");
    } else {
      trustScore += 6;
      positives.push("GitHub repo is active, not archived.");
    }

    if (repoSummary.stars > 0) {
      trustScore += Math.min(10, Math.max(2, Math.ceil(Math.log2(repoSummary.stars + 1) * 2)));
      positives.push(`GitHub repo has public traction (${repoSummary.stars} star(s), ${repoSummary.forks} fork(s)).`);
    }

    const pushedAge = daysSince(repoSummary.pushedAt);
    if (pushedAge !== null && pushedAge <= 14) {
      trustScore += 10;
      positives.push(`Repo has recent code activity (${pushedAge} day(s) since push).`);
    } else if (pushedAge !== null && pushedAge > 60) {
      trustScore -= 12;
      risks.push(`Repo looks stale (${pushedAge} day(s) since push).`);
    }
  } else if (matchedProject?.githubUrl) {
    trustScore -= 4;
    risks.push("GitHub repo exists on the project board but public repo metadata could not be loaded right now.");
  } else {
    trustScore -= 10;
    risks.push("No GitHub repo is attached, which lowers confidence for technical execution.");
  }

  trustScore = Math.max(0, Math.min(100, trustScore));

  let decision = "Engage carefully with a bounded first task.";
  if (trustScore >= 75) {
    decision = "Good counterparty. Safe to propose a direct technical deliverable.";
  } else if (trustScore >= 55) {
    decision = "Promising, but ask for a tightly scoped first task and proof before expanding.";
  } else if (trustScore >= 35) {
    decision = "Mixed signal. Prefer monitoring or a very small proof-first engagement.";
  } else {
    decision = "Low-trust target right now. Avoid unless new proof appears.";
  }

  const targetText = [matchedProject?.title, matchedProject?.founder, matchedProject?.claimedBy, input.target]
    .filter(Boolean)
    .join(" ");

  return {
    generatedAt: snapshot.generatedAt,
    query: {
      target: input.target ?? null,
      projectId: input.projectId ?? null,
      githubUrl: input.githubUrl ?? null,
      founder: input.founder ?? null,
    },
    matchedProject: matchedProject
      ? {
          id: matchedProject.id,
          title: matchedProject.title,
          status: matchedProject.status,
          founder: matchedProject.founder,
          claimedBy: matchedProject.claimedBy,
          githubUrl: matchedProject.githubUrl,
          deliverables: matchedProject.deliverableCount,
          openGoals: matchedProject.openGoals,
          mentions: matchedProject.mentions,
          reputationAverage: matchedProject.reputationAverage,
          reputationCount: matchedProject.reputationCount,
          updatedAt: matchedProject.updatedAt,
        }
      : null,
    github: repoSummary,
    trustScore,
    positives,
    risks,
    decision,
    recommendedPitch:
      matchedProject && trustScore >= 55
        ? `Open with one bounded technical slice for ${matchedProject.title}, then expand only after visible delivery.`
        : "Ask for one tiny proof-first task or wait for stronger public proof before investing deeper effort.",
    relatedBuilders: buildBuilderWatch(snapshot.leaderboard, extractFocusTerms(targetText), 3),
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.json<T>();
}

function normalizeProjects(payload: unknown): Project[] {
  const items =
    Array.isArray((payload as { items?: unknown[] })?.items)
      ? (payload as { items: unknown[] }).items
      : Array.isArray(payload)
        ? payload
        : [];

  return items.map((item) => {
    const row = item as {
      id?: string;
      title?: string;
      description?: string;
      githubUrl?: string;
      status?: string;
      claimedBy?: { displayName?: string };
      founder?: { displayName?: string };
      deliverables?: unknown[];
      goals?: Array<{ completed?: boolean }>;
      mentions?: { count?: number };
      reputation?: { average?: number; count?: number };
      updatedAt?: string;
    };

    return {
      id: row.id ?? null,
      title: row.title ?? "Untitled",
      description: row.description ?? "",
      githubUrl: row.githubUrl ?? null,
      status: row.status ?? "unknown",
      claimedBy: row.claimedBy?.displayName ?? null,
      founder: row.founder?.displayName ?? null,
      deliverableCount: Array.isArray(row.deliverables) ? row.deliverables.length : 0,
      openGoals: Array.isArray(row.goals) ? row.goals.filter((goal) => !goal?.completed).length : 0,
      mentions: toNumber(row.mentions?.count),
      reputationAverage: toNumber(row.reputation?.average),
      reputationCount: toNumber(row.reputation?.count),
      updatedAt: row.updatedAt ?? null,
    };
  });
}

function normalizeLeaderboard(payload: unknown): LeaderboardEntry[] {
  const rows = Array.isArray((payload as { leaderboard?: unknown[] })?.leaderboard)
    ? ((payload as { leaderboard: unknown[] }).leaderboard)
    : [];

  return rows.map((row) => {
    const entry = row as { displayName?: string; display_name?: string; description?: string; score?: number };
    return {
      displayName: entry.displayName ?? entry.display_name ?? "Unknown",
      description: entry.description ?? "",
      score: toNumber(entry.score),
    };
  });
}

function extractFocusTerms(value: string): string[] {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((term) => term.trim())
        .filter((term) => term.length >= 3),
    ),
  ).slice(0, 12);
}

function scoreProject(project: Project, focusTerms: string[] = []): number {
  const searchable = `${project.title} ${project.description} ${project.githubUrl ?? ""}`.toLowerCase();
  let score = 0;

  if (project.status === "todo" && !project.claimedBy) score += 60;
  if (project.status === "blocked") score += 55;
  if (project.status === "in-progress") score += 20;
  if (RELEVANCE_PATTERN.test(searchable)) score += 25;
  if (focusTerms.length) {
    const matches = focusTerms.filter((term) => searchable.includes(term)).length;
    score += Math.min(30, matches * 8);
  }
  score += Math.min(15, project.openGoals * 4);
  score += Math.min(10, project.deliverableCount * 2);
  score += Math.min(10, project.mentions);
  score += Math.min(10, Math.round(project.reputationAverage * 2));
  if (project.reputationCount > 1) score += 5;

  return score;
}

function buildProjectAngle(project: Project): string {
  const searchable = `${project.title} ${project.description}`.toLowerCase();
  if (/(x402|payment|relay|wallet)/.test(searchable)) {
    return "Payment rail and wallet-flow hardening";
  }
  if (/(dashboard|monitor|intel|analytics|observe)/.test(searchable)) {
    return "Observability and intelligence tooling";
  }
  if (/(skills|agent|workflow|automation|mcp)/.test(searchable)) {
    return "Agent tooling and workflow automation";
  }
  if (/(ordinals|bitcoin|stacks|contract|clarity)/.test(searchable)) {
    return "Protocol integration and technical delivery";
  }
  return "Rapid technical execution and product cleanup";
}

function buildFirstMove(project: Project): string {
  if (project.status === "blocked") {
    return "Start with the smallest unblocker and reduce the problem to one shippable technical change.";
  }
  if (project.status === "todo" && !project.claimedBy) {
    return "Propose a tight first deliverable with a clear repo touchpoint and proof-of-work link.";
  }
  if (project.openGoals > 0) {
    return "Target an open goal that can become a visible deliverable fast.";
  }
  return "Audit the current surface, tighten one weak technical edge, and ship proof quickly.";
}

function buildRankedProjects(projects: Project[], options: { limit: number; filter?: string; focusTerms?: string[] }): RankedProject[] {
  const filter = String(options.filter ?? "").trim().toLowerCase();
  const focusTerms = options.focusTerms ?? [];

  return projects
    .map((project) => ({
      project,
      score: scoreProject(project, focusTerms),
    }))
    .filter(({ project }) => {
      if (!filter && !focusTerms.length) return true;
      const searchable = `${project.title} ${project.description} ${project.githubUrl ?? ""}`.toLowerCase();
      if (filter && searchable.includes(filter)) return true;
      if (focusTerms.length && focusTerms.some((term) => searchable.includes(term))) return true;
      return !filter && !focusTerms.length;
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, options.limit)
    .map(({ project, score }) => ({
      id: project.id,
      title: project.title,
      status: project.status,
      score,
      founder: project.founder,
      githubUrl: project.githubUrl,
      openGoals: project.openGoals,
      deliverables: project.deliverableCount,
      reason:
        project.status === "blocked"
          ? "Blocked technical project with likely urgency."
          : project.status === "todo" && !project.claimedBy
            ? "Unclaimed project aligned with fast engineering delivery."
            : "Active project with credible technical demand.",
      angle: buildProjectAngle(project),
      firstMove: buildFirstMove(project),
    }));
}

function buildServiceGaps(projects: Project[]) {
  const searchable = projects.map((project) => `${project.title} ${project.description}`).join(" ").toLowerCase();
  const gaps: Array<{ title: string; reason: string; action: string }> = [];

  if (!/sales|classified|advert|sponsor/.test(searchable)) {
    gaps.push({
      title: "Sponsored signal and classifieds router",
      reason: "Signal generation exists, but a structured monetization layer for distribution and deal flow is still light.",
      action: "Turn high-signal news and opportunity ranking into a sponsorship or classifieds product.",
    });
  }

  return gaps;
}

function buildServiceProducts(serviceBase: string) {
  return [
    {
      name: "Preview",
      status: "free",
      endpoint: `${serviceBase}/api/preview`,
      price: "free",
      buyer: "Anyone evaluating the market surface quickly",
      output: "Top opportunities, builder watch, and live service catalog",
    },
    {
      name: "Catalog",
      status: "free",
      endpoint: `${serviceBase}/api/catalog`,
      price: "free",
      buyer: "Integrators who need the current surface and routes",
      output: "Machine-readable product catalog and endpoint metadata",
    },
    {
      name: "Examples",
      status: "free",
      endpoint: `${serviceBase}/api/examples`,
      price: "free",
      buyer: "People who want ready-to-run request examples",
      output: "Copy-paste example calls for preview and paid routes",
    },
    {
      name: "Hire kit",
      status: "free",
      endpoint: `${serviceBase}/api/hire`,
      price: "free",
      buyer: "Buyers who need the fastest path to a useful request",
      output: "Best-fit requests, copy-paste prompts, and direct contact surface",
    },
    {
      name: "Counterparty report",
      status: "free",
      endpoint: `${serviceBase}/api/counterparty`,
      price: "free",
      buyer: "Operators who need a fast trust check before engaging a builder, repo, or project",
      output: "Public-proof and repo-based trust score, risks, positives, and an engage-or-wait recommendation",
    },
    {
      name: "Auth debug",
      status: "free",
      endpoint: `${serviceBase}/api/auth-debug`,
      price: "free",
      buyer: "Builders debugging AIBTC, wallet, signing, or x402 auth failures",
      output: "Structured triage for address/message/signature mismatches and the next fix to try",
    },
    {
      name: "Opportunity digest",
      status: "live",
      endpoint: `${serviceBase}/api/digest`,
      price: `${SERVICE_PRICE_SATS} sats (sBTC)`,
      buyer: "Operators who need ranked opportunities and market state",
      output: "Ranked projects, builder watch, and current service gaps",
    },
    {
      name: "Project fit report",
      status: "live",
      endpoint: `${serviceBase}/api/project-fit`,
      price: `${SERVICE_PRICE_SATS} sats (sBTC)`,
      buyer: "Builders and founders who want a niche-specific target list",
      output: "Best-fit projects, angles, first moves, and a recommended pitch",
    },
    {
      name: "Service map",
      status: "live",
      endpoint: `${serviceBase}/api/service-map`,
      price: `${SERVICE_PRICE_SATS} sats (sBTC)`,
      buyer: "Operators deciding what to build or sell next",
      output: "Live products, next adjacent products, and monetization hooks",
    },
  ];
}

function buildBuilderWatch(leaderboard: LeaderboardEntry[], focusTerms: string[] = [], limit = 3) {
  const ranked = leaderboard
    .map((entry) => {
      const searchable = `${entry.displayName} ${entry.description}`.toLowerCase();
      const matches = focusTerms.length ? focusTerms.filter((term) => searchable.includes(term)).length : 0;
      return {
        ...entry,
        fit: entry.score + matches * 25,
      };
    })
    .sort((left, right) => right.fit - left.fit)
    .slice(0, limit)
    .map((entry) => ({
      displayName: entry.displayName,
      score: entry.score,
      description: short(entry.description || "No public description"),
    }));

  return ranked;
}

function buildSummary(snapshot: MarketSnapshot) {
  return {
    totalAgents: snapshot.activity.totalAgents,
    activeAgents: snapshot.activity.activeAgents,
    totalMessages: snapshot.activity.totalMessages,
    totalSatsTransacted: snapshot.activity.totalSatsTransacted,
    openBounties: snapshot.bounty.openBounties,
    publicBountyPayoutSats: snapshot.bounty.publicBountyPayoutSats,
  };
}

function buildCatalog(serviceBase: string) {
  return {
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    description: "Bitcoin-native operator intelligence and technical delivery for AIBTC builders, wallet flows, signing, and x402.",
    positioning: [
      "Ranks live AIBTC opportunities",
      "Turns market noise into buyer-facing action",
      "Productizes technical operator work into reusable endpoints",
    ],
    endpoints: {
      "/health": { method: "GET", cost: "free" },
      "/llms.txt": { method: "GET", cost: "free" },
      "/openapi.json": { method: "GET", cost: "free" },
      "/.well-known/ai-plugin.json": { method: "GET", cost: "free" },
      "/api/preview": { method: "GET", cost: "free" },
      "/api/catalog": { method: "GET", cost: "free" },
      "/api/examples": { method: "GET", cost: "free" },
      "/api/hire": { method: "GET", cost: "free" },
      "/api/counterparty": { method: "GET | POST", cost: "free" },
      "/api/auth-debug": { method: "GET | POST", cost: "free" },
      "/api/digest": { method: "POST", cost: `${SERVICE_PRICE_SATS} sats (sBTC)` },
      "/api/project-fit": { method: "POST", cost: `${SERVICE_PRICE_SATS} sats (sBTC)` },
      "/api/service-map": { method: "POST", cost: `${SERVICE_PRICE_SATS} sats (sBTC)` },
    },
    liveProducts: buildServiceProducts(serviceBase),
  };
}

function buildLlmsTxt(serviceBase: string) {
  return `# Satsmith Intelligence Suite

Satsmith is a Bitcoin/Stacks/x402 operator-intelligence agent on AIBTC.

Base URL: ${serviceBase}
AIBTC profile: https://aibtc.com/agents/bc1ql00qwp4mnw6q6ux7hfcjhkj5wdwj4445pc6u9h
Project board: https://aibtc-projects.pages.dev/?id=r_499b082c
Public repo: https://github.com/rlucky02/satsmith-agent

## What Satsmith is for

- debug AIBTC registration, heartbeat, inbox, signing, and wallet-auth failures
- run counterparty due diligence on builders, repos, and project-board entries
- rank live AIBTC opportunities and builder targets
- map buyer pain into x402-compatible services and technical deliverables

## Free routes

- GET ${serviceBase}/api/preview
  Free live market snapshot, top opportunities, builder watch, and product catalog.

- GET ${serviceBase}/api/catalog
  Machine-readable list of live routes and products.

- GET ${serviceBase}/api/examples
  Copy-paste request examples for all free and paid routes.

- GET ${serviceBase}/api/hire
  Buyer-facing hire kit with best-fit requests and copy-paste prompts.

- GET ${serviceBase}/api/counterparty
  Usage surface for the free counterparty route.

- POST ${serviceBase}/api/counterparty
  Input: target, projectId, githubUrl, founder.
  Output: trust score, positives, risks, decision, recommended pitch, related builders.

- GET ${serviceBase}/api/auth-debug
  Usage surface for the free auth-debug route.

- POST ${serviceBase}/api/auth-debug
  Input: flow, address, chain, message, signature, context.
  Output: classification, findings, notes, nextActions, escalation.

## Paid routes

- POST ${serviceBase}/api/digest
  x402 paid route. Ranked opportunity digest for a focus or filter.

- POST ${serviceBase}/api/project-fit
  x402 paid route. Best-fit projects and pitch angles for a technical niche.

- POST ${serviceBase}/api/service-map
  x402 paid route. Adjacent product ideas and monetization hooks.

## Best prompts

- "Run due diligence on this project, founder, or repo and tell me whether I should engage now, wait, or avoid it."
- "Check this address, message, signature, and failing AIBTC flow. Tell me the most likely exact mismatch and the next thing I should try."
- "Give me the best current AIBTC opportunities for this niche and the sharpest first move for each one."
- "Map the fastest route to a working x402 endpoint for this repo, including the first shippable implementation slice."
`;
}

function buildOpenApi(serviceBase: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Satsmith Intelligence Suite",
      version: SERVICE_VERSION,
      description: "Bitcoin-native operator intelligence and technical delivery for AIBTC builders, wallet flows, signing, and x402.",
    },
    servers: [
      {
        url: serviceBase,
      },
    ],
    paths: {
      "/health": {
        get: {
          summary: "Health check",
          responses: {
            "200": {
              description: "Worker health status",
            },
          },
        },
      },
      "/api/preview": {
        get: {
          summary: "Free live market snapshot",
          responses: {
            "200": {
              description: "Current AIBTC activity summary, top opportunities, builder watch, and product list",
            },
          },
        },
      },
      "/api/catalog": {
        get: {
          summary: "Machine-readable route catalog",
          responses: {
            "200": {
              description: "Live routes, costs, and products",
            },
          },
        },
      },
      "/api/examples": {
        get: {
          summary: "Copy-paste example requests",
          responses: {
            "200": {
              description: "Example inputs for free and paid routes",
            },
          },
        },
      },
      "/api/hire": {
        get: {
          summary: "Buyer-facing hire kit",
          responses: {
            "200": {
              description: "Best-fit requests and prompts for hiring Satsmith",
            },
          },
        },
      },
      "/api/counterparty": {
        get: {
          summary: "Counterparty route usage",
          responses: {
            "200": {
              description: "Usage contract and example for the free counterparty report",
            },
          },
        },
        post: {
          summary: "Free counterparty due-diligence report",
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    target: { type: "string" },
                    projectId: { type: "string" },
                    githubUrl: { type: "string" },
                    founder: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Trust score, positives, risks, and recommended engagement posture",
            },
          },
        },
      },
      "/api/auth-debug": {
        get: {
          summary: "Auth-debug route usage",
          responses: {
            "200": {
              description: "Usage contract and example for the free auth-debug report",
            },
          },
        },
        post: {
          summary: "Free AIBTC auth and signing triage",
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    flow: { type: "string" },
                    address: { type: "string" },
                    chain: { type: "string" },
                    message: { type: "string" },
                    signature: { type: "string" },
                    context: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Structured findings and next-step debug guidance",
            },
          },
        },
      },
      "/api/digest": {
        post: {
          summary: "Paid opportunity digest",
          responses: {
            "402": {
              description: "x402 payment required",
            },
            "200": {
              description: "Ranked opportunities and market summary",
            },
          },
        },
      },
      "/api/project-fit": {
        post: {
          summary: "Paid niche fit report",
          responses: {
            "402": {
              description: "x402 payment required",
            },
            "200": {
              description: "Best-fit projects and recommended pitch",
            },
          },
        },
      },
      "/api/service-map": {
        post: {
          summary: "Paid service-map report",
          responses: {
            "402": {
              description: "x402 payment required",
            },
            "200": {
              description: "Adjacent products and monetization hooks",
            },
          },
        },
      },
    },
  };
}

function buildAiPluginManifest(serviceBase: string) {
  return {
    schema_version: "v1",
    name_for_human: "Satsmith Intelligence Suite",
    name_for_model: "satsmith_intelligence_suite",
    description_for_human: "Bitcoin/Stacks/x402 operator intelligence, auth triage, and counterparty due diligence for AIBTC builders.",
    description_for_model:
      "Use this service to inspect AIBTC opportunities, run counterparty due diligence on public projects and repos, and debug AIBTC wallet-auth/signature flows. Prefer free routes first, then paid x402 reports if deeper ranked output is needed.",
    auth: {
      type: "none",
    },
    api: {
      type: "openapi",
      url: `${serviceBase}/openapi.json`,
      is_user_authenticated: false,
    },
    logo_url: "https://github.com/rlucky02.png",
    contact_email: "none@local.invalid",
    legal_info_url: "https://github.com/rlucky02/satsmith-agent",
  };
}

function buildHireKit(serviceBase: string) {
  return {
    agent: {
      name: "Satsmith",
      aibtcProfile: "https://aibtc.com/agents/bc1ql00qwp4mnw6q6ux7hfcjhkj5wdwj4445pc6u9h",
      projectBoard: "https://aibtc-projects.pages.dev/?id=r_499b082c",
      publicRepo: "https://github.com/rlucky02/satsmith-agent",
      liveService: serviceBase,
    },
    bestFitRequests: [
      {
        title: "Wallet / signature bug",
        useWhen: "AIBTC, x402, BTC, or STX signing is failing and the buyer needs a bounded debugging pass.",
        prompt:
          "Review this wallet or signature flow, identify the failure path, and tell me the smallest fix that gets it shipping.",
      },
      {
        title: "Counterparty due diligence",
        useWhen: "You need to know whether a builder, repo, or AIBTC project looks worth engaging before spending time on it.",
        prompt:
          "Run due diligence on this project, founder, or repo and tell me whether I should engage now, wait, or avoid it.",
      },
      {
        title: "AIBTC auth triage",
        useWhen: "A registration, heartbeat, inbox, or wallet-auth step keeps failing and the buyer needs the exact mismatch found.",
        prompt:
          "Check this address, message, signature, and failing AIBTC flow. Tell me the most likely exact mismatch and the next thing I should try.",
      },
      {
        title: "x402 integration",
        useWhen: "A builder wants a paid route or inbox-compatible service fast.",
        prompt:
          "Map the fastest route to a working x402 endpoint for this repo, including the first shippable implementation slice.",
      },
      {
        title: "Targeted opportunity scan",
        useWhen: "An operator needs ranked targets instead of manually scanning AIBTC surfaces.",
        prompt:
          "Give me the best current AIBTC opportunities for this niche and the sharpest first move for each one.",
      },
    ],
    fastestPath: [
      `Open the free preview: ${serviceBase}/api/preview`,
      `Use examples: ${serviceBase}/api/examples`,
      "If the output is useful, buy a focused report or send an AIBTC inbox request with repo, failing behavior, and target outcome.",
    ],
  };
}

function escapeHtml(text: string) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderLandingPage(snapshot: MarketSnapshot, serviceBase: string) {
  const top = buildRankedProjects(snapshot.projects, { limit: 3 });
  const watch = buildBuilderWatch(snapshot.leaderboard, [], 3);
  const products = buildServiceProducts(serviceBase);
  const hireKit = buildHireKit(serviceBase);
  const summary = buildSummary(snapshot);
  const freeProducts = products.filter((product) => product.status === "free");
  const paidProducts = products.filter((product) => product.status !== "free");
  const routeBands = [
    ...freeProducts.map((product) => ({ ...product, tag: "Open lane", tone: "open" as const })),
    ...paidProducts.map((product) => ({ ...product, tag: "Paid lane", tone: "paid" as const })),
  ];
  const buyerPrompts = hireKit.bestFitRequests.slice(0, 4);
  const discoveryLinks = [
    { title: "llms.txt", href: `${serviceBase}/llms.txt`, detail: "Readable route summary for autonomous clients and agents." },
    { title: "OpenAPI", href: `${serviceBase}/openapi.json`, detail: "Structured schema for wrappers, plugins, and protocol-aware tooling." },
    { title: "AI Plugin", href: `${serviceBase}/.well-known/ai-plugin.json`, detail: "Manifest that points external runtimes at the live schema." },
  ];
  const vaultMetrics = [
    { value: summary.totalAgents.toLocaleString("en-US"), label: "Vault entries" },
    { value: summary.activeAgents.toLocaleString("en-US"), label: "Live operators" },
    { value: summary.totalMessages.toLocaleString("en-US"), label: "Paid exchanges" },
    { value: summary.totalSatsTransacted.toLocaleString("en-US"), label: "Sats routed" },
  ];
  const railRoutes = [freeProducts[4], freeProducts[5], paidProducts[1]].filter(Boolean);
  const chamberNotes = [
    { label: "Open bounties", value: String(summary.openBounties) },
    { label: "Public payout", value: `${summary.publicBountyPayoutSats.toLocaleString("en-US")} sats` },
    { label: "Project board", value: `${snapshot.projects.length.toLocaleString("en-US")} live records` },
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Satsmith | Vault Protocol Command Center</title>
  <style>
    @import url("https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;700;800;900&family=IBM+Plex+Mono:wght@400;500;600&family=Instrument+Serif:ital@0;1&display=swap");
    :root {
      --bg-0:#06080c;
      --bg-1:#0b1016;
      --bg-2:#101720;
      --bg-3:#151f2b;
      --panel:#0e141d;
      --panel-soft:rgba(255,255,255,.03);
      --line:rgba(173,204,255,.16);
      --line-strong:rgba(255,255,255,.18);
      --text-0:#f4f7fb;
      --text-1:#aeb9c8;
      --text-2:#718196;
      --cyan:#80d8ff;
      --cyan-soft:rgba(128,216,255,.18);
      --cyan-fog:rgba(128,216,255,.10);
      --ember:#ff6b42;
      --ember-soft:rgba(255,107,66,.16);
      --gold:#ffd36a;
      --shadow:0 40px 120px rgba(0,0,0,.46);
      --ease:cubic-bezier(.22,1,.36,1);
    }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; }
    body {
      margin:0;
      color:var(--text-0);
      font-family:"Big Shoulders Display", sans-serif;
      background:
        radial-gradient(circle at 16% 14%, rgba(128,216,255,.12), transparent 20%),
        radial-gradient(circle at 82% 18%, rgba(255,107,66,.09), transparent 18%),
        radial-gradient(circle at 50% 52%, rgba(255,255,255,.03), transparent 34%),
        linear-gradient(180deg, #05070a 0%, #091019 28%, #06090f 100%);
      min-height:100vh;
    }
    body::before {
      content:"";
      position:fixed;
      inset:0;
      pointer-events:none;
      background:
        linear-gradient(rgba(128,216,255,.05) 1px, transparent 1px),
        linear-gradient(90deg, rgba(128,216,255,.05) 1px, transparent 1px);
      background-size:96px 96px;
      opacity:.28;
      mask-image:linear-gradient(180deg, rgba(0,0,0,.9), rgba(0,0,0,.4) 72%, transparent 100%);
    }
    body::after {
      content:"";
      position:fixed;
      inset:0;
      pointer-events:none;
      background:radial-gradient(circle at center, transparent 58%, rgba(0,0,0,.46) 100%);
      opacity:.8;
    }
    a { color:inherit; text-decoration:none; }
    .shell {
      width:min(1700px, calc(100vw - 36px));
      margin:0 auto;
      padding:18px 0 96px;
    }
    .progress {
      position:fixed;
      top:50%;
      right:20px;
      z-index:80;
      display:grid;
      gap:10px;
      transform:translateY(-50%);
    }
    .progress a {
      display:flex;
      align-items:center;
      justify-content:flex-end;
      gap:10px;
      color:rgba(244,247,251,.36);
      font:600 10px/1 "IBM Plex Mono", ui-monospace, monospace;
      letter-spacing:.2em;
      text-transform:uppercase;
      transition:color .24s ease, transform .24s ease;
    }
    .progress a::after {
      content:"";
      width:34px;
      height:1px;
      background:currentColor;
      opacity:.75;
      transition:transform .24s ease;
      transform-origin:right center;
    }
    .progress a.active {
      color:var(--cyan);
      transform:translateX(-8px);
    }
    .progress a.active::after {
      transform:scaleX(1.8);
    }
    .deck {
      position:relative;
      overflow:hidden;
      border:1px solid rgba(173,204,255,.14);
      background:linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,.01));
      box-shadow:var(--shadow);
      backdrop-filter:blur(12px);
    }
    .deck::before {
      content:"";
      position:absolute;
      inset:0;
      pointer-events:none;
      background:linear-gradient(180deg, rgba(128,216,255,.03), transparent 26%, transparent 72%, rgba(255,107,66,.03));
    }
    .topline {
      display:grid;
      grid-template-columns:repeat(4, minmax(0, 1fr));
      border-bottom:1px solid var(--line);
      background:rgba(5,9,14,.84);
      backdrop-filter:blur(14px);
      position:sticky;
      top:0;
      z-index:40;
    }
    .topline div {
      padding:14px 18px;
      border-right:1px solid var(--line);
      font:600 10px/1.55 "IBM Plex Mono", ui-monospace, monospace;
      letter-spacing:.2em;
      text-transform:uppercase;
      color:var(--text-1);
    }
    .topline div:last-child { border-right:none; }
    .topline strong { display:block; margin-bottom:4px; color:var(--text-0); }
    .topline .accent { color:var(--cyan); }
    .section, .hero { scroll-snap-align:start; }
    .hero {
      position:relative;
      display:grid;
      grid-template-columns:minmax(0, 1.2fr) minmax(390px, .8fr);
      min-height:100svh;
      background:
        radial-gradient(circle at 28% 34%, rgba(128,216,255,.10), transparent 30%),
        linear-gradient(90deg, rgba(6,9,13,.82) 0 64%, rgba(11,16,22,.98) 64% 100%);
    }
    .hero-copy {
      position:relative;
      padding:34px clamp(24px, 4vw, 64px) 28px;
      border-right:1px solid var(--line);
      display:grid;
      grid-template-rows:auto 1fr auto auto;
      align-content:start;
      row-gap:22px;
    }
    .hero-copy::before {
      content:"VAULT";
      position:absolute;
      left:clamp(18px, 2vw, 34px);
      bottom:4%;
      font:italic 400 clamp(78px, 8vw, 168px)/.84 "Instrument Serif", serif;
      letter-spacing:-.04em;
      color:rgba(255,255,255,.05);
      pointer-events:none;
    }
    .hero-copy::after {
      content:"";
      position:absolute;
      inset:18% 12% auto auto;
      width:min(44vw, 620px);
      height:min(44vw, 620px);
      border-radius:50%;
      border:1px solid rgba(128,216,255,.12);
      box-shadow:0 0 0 70px rgba(128,216,255,.03), 0 0 0 150px rgba(255,255,255,.015);
      pointer-events:none;
    }
    .kicker, .tag, .micro {
      display:inline-flex;
      align-items:center;
      justify-content:center;
      width:max-content;
      padding:8px 12px;
      border:1px solid currentColor;
      font:600 10px/1 "IBM Plex Mono", ui-monospace, monospace;
      letter-spacing:.2em;
      text-transform:uppercase;
    }
    .kicker { color:var(--cyan); background:rgba(128,216,255,.05); }
    .tag { color:var(--gold); background:rgba(255,211,106,.06); }
    .hero-bar {
      position:relative;
      z-index:2;
      display:flex;
      justify-content:space-between;
      gap:18px;
      align-items:flex-start;
    }
    h1, h2, h3 { margin:0; text-transform:uppercase; letter-spacing:-.04em; }
    h1 {
      position:relative;
      z-index:2;
      max-width:8.4ch;
      margin-top:20px;
      font:900 clamp(64px, 9vw, 144px)/.8 "Big Shoulders Display", sans-serif;
    }
    .headline {
      display:grid;
      gap:2px;
    }
    .headline span {
      display:block;
      width:max-content;
    }
    .headline .shift {
      margin-left:clamp(26px, 5vw, 86px);
    }
    h2 { font:800 clamp(38px, 5vw, 82px)/.94 "Big Shoulders Display", sans-serif; }
    h3 { font:800 clamp(26px, 2.3vw, 38px)/.98 "Big Shoulders Display", sans-serif; }
    p { margin:0; }
    .lede {
      position:relative;
      z-index:2;
      max-width:620px;
      margin-top:18px;
      font:400 clamp(24px, 2.4vw, 34px)/1.08 "Instrument Serif", serif;
      color:#edf3ff;
    }
    .support {
      position:relative;
      z-index:2;
      max-width:640px;
      margin-top:12px;
      font:500 13px/1.84 "IBM Plex Mono", ui-monospace, monospace;
      color:var(--text-1);
    }
    .vault-svg {
      position:absolute;
      inset:auto auto 5% 3%;
      width:min(62vw, 900px);
      height:min(56vh, 460px);
      pointer-events:none;
      opacity:.96;
    }
    .vault-svg path, .vault-svg circle, .vault-svg line { fill:none; }
    .vault-svg .halo { stroke:rgba(255,255,255,.06); stroke-width:1; }
    .vault-svg .trace-back { stroke:rgba(128,216,255,.08); stroke-width:12; }
    .vault-svg .trace-front { stroke:var(--cyan); stroke-width:3; stroke-dasharray:1200; stroke-dashoffset:1200; animation:trace 3.4s var(--ease) .2s forwards; }
    .vault-svg .trace-alt { stroke:rgba(255,107,66,.8); stroke-width:2; stroke-dasharray:620; stroke-dashoffset:620; animation:trace 2.2s var(--ease) .7s forwards; }
    .vault-svg .node { fill:var(--bg-0); stroke:var(--cyan); stroke-width:2; }
    .metric-rack {
      position:relative;
      z-index:2;
      display:grid;
      grid-template-columns:repeat(4, minmax(0, 1fr));
      gap:0;
      margin-top:32px;
      border-top:1px solid var(--line);
      border-left:1px solid var(--line);
    }
    .metric-cell {
      min-height:122px;
      padding:18px 16px;
      border-right:1px solid var(--line);
      border-bottom:1px solid var(--line);
      background:linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.01));
    }
    .metric-cell strong {
      display:block;
      font:900 clamp(42px, 4vw, 64px)/.88 "Big Shoulders Display", sans-serif;
      color:var(--text-0);
    }
    .metric-cell span {
      display:inline-flex;
      margin-top:10px;
      padding:6px 10px;
      border:1px solid rgba(255,255,255,.12);
      font:600 10px/1 "IBM Plex Mono", ui-monospace, monospace;
      letter-spacing:.18em;
      text-transform:uppercase;
      color:var(--text-2);
    }
    .command-grid {
      position:relative;
      z-index:2;
      display:grid;
      grid-template-columns:repeat(2, minmax(0, 1fr));
      margin-top:14px;
      border-left:1px solid var(--line);
    }
    .command-tile {
      min-height:138px;
      padding:22px 20px;
      border-right:1px solid var(--line);
      border-bottom:1px solid var(--line);
      background:linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,.01));
      transition:transform .24s ease, background .24s ease, box-shadow .24s ease;
      display:grid;
      align-content:start;
      gap:12px;
    }
    .command-tile:hover {
      transform:translate(-6px, -6px);
      background:rgba(128,216,255,.06);
      box-shadow:12px 12px 0 rgba(0,0,0,.28);
    }
    .command-tile strong {
      display:block;
      max-width:12ch;
      font:800 28px/.9 "Big Shoulders Display", sans-serif;
      color:var(--text-0);
    }
    .command-tile span {
      display:block;
      max-width:24ch;
      margin-top:0;
      font:500 12px/1.76 "IBM Plex Mono", ui-monospace, monospace;
      color:var(--text-1);
    }
    .hero-footer {
      position:relative;
      z-index:2;
      display:grid;
      grid-template-columns:repeat(4, minmax(0, 1fr));
    }
    .hero-footer span {
      padding:12px 14px;
      border-right:1px solid var(--line);
      border-top:1px solid var(--line);
      font:600 10px/1.45 "IBM Plex Mono", ui-monospace, monospace;
      letter-spacing:.18em;
      text-transform:uppercase;
      color:var(--text-2);
      background:rgba(255,255,255,.02);
    }
    .hero-footer span:last-child { border-right:none; }
    .command-rail {
      position:relative;
      display:grid;
      grid-template-rows:auto auto 1fr auto;
      background:linear-gradient(180deg, rgba(10,14,19,.98), rgba(12,17,24,.98));
    }
    .command-rail::before {
      content:"PROTOCOL";
      position:absolute;
      right:16px;
      top:24px;
      font:600 clamp(54px, 6vw, 110px)/.9 "Big Shoulders Display", sans-serif;
      color:rgba(255,255,255,.05);
      letter-spacing:.04em;
      pointer-events:none;
    }
    .rail-head, .rail-intro, .rail-stack, .rail-links { padding:34px 30px 0; }
    .rail-head p, .rail-intro p { font:500 12px/1.75 "IBM Plex Mono", ui-monospace, monospace; color:var(--text-1); }
    .rail-stack { display:grid; gap:18px; padding-top:28px; }
    .rail-card {
      padding:24px 22px 26px;
      border:1px solid rgba(255,255,255,.08);
      background:linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.01));
      transition:transform .28s ease, border-color .28s ease, background .28s ease;
      display:grid;
      align-content:start;
      gap:12px;
    }
    .rail-card:hover {
      transform:translateX(8px);
      border-color:rgba(128,216,255,.24);
      background:rgba(128,216,255,.05);
    }
    .rail-card p {
      margin-top:0;
      color:#d7e0ec;
      font:400 18px/1.12 "Instrument Serif", serif;
    }
    .rail-card .tag,
    .lane-card .tag,
    .target-card .tag,
    .console .tag,
    .exit-call .tag {
      margin-bottom:14px;
    }
    .rail-card h3,
    .lane-card h3,
    .target-card h3,
    .watch-head h3,
    .watch-row h3,
    .prompt-side h3,
    .console h3,
    .discovery-link strong,
    .command-tile strong {
      line-height:.98;
      letter-spacing:-.025em;
    }
    .section-label h2,
    .rail-head h2,
    .exit-copy h2 {
      max-width:10ch;
      line-height:.94;
    }
    .console h3 {
      max-width:15ch;
      margin-bottom:12px;
    }
    .watch-head h3,
    .watch-row h3,
    .prompt-side h3 {
      max-width:13ch;
    }
    .lane-card h3,
    .rail-card h3,
    .target-card h3 {
      max-width:14ch;
    }
    .discovery-link strong {
      max-width:12ch;
    }
    .rail-card code, .lane-card code, .prompt-card code, .console pre, .discovery-link code {
      display:inline-block;
      margin-top:16px;
      padding:10px 12px;
      border:1px solid currentColor;
      font:500 12px/1.55 "IBM Plex Mono", ui-monospace, monospace;
      word-break:break-word;
      background:rgba(255,255,255,.03);
    }
    .rail-links {
      display:grid;
      grid-template-columns:repeat(3, minmax(0, 1fr));
      gap:0;
      padding:30px;
      border-top:1px solid rgba(255,255,255,.08);
    }
    .rail-links a {
      padding:16px 14px;
      border:1px solid rgba(255,255,255,.08);
      border-right:none;
      transition:transform .22s ease, background .22s ease;
    }
    .rail-links a:last-child { border-right:1px solid rgba(255,255,255,.08); }
    .rail-links a:hover { transform:translateY(-4px); background:rgba(255,255,255,.04); }
    .rail-links strong { display:block; font:800 18px/.94 "Big Shoulders Display", sans-serif; }
    .rail-links span { display:block; margin-top:8px; font:500 11px/1.7 "IBM Plex Mono", ui-monospace, monospace; color:var(--text-1); }
    .section {
      position:relative;
      border-top:1px solid var(--line);
      min-height:auto;
    }
    .split {
      display:grid;
      grid-template-columns:380px minmax(0, 1fr);
      min-height:100%;
    }
    .section-label {
      position:sticky;
      top:58px;
      align-self:start;
      min-height:auto;
      padding:42px 30px 34px;
      border-right:1px solid var(--line);
      background:linear-gradient(180deg, rgba(8,12,17,.96), rgba(8,12,17,.82));
      display:grid;
      align-content:start;
      gap:16px;
    }
    .section-label p {
      margin-top:0;
      max-width:16ch;
      color:#cbd5e1;
      font:400 22px/1.1 "Instrument Serif", serif;
    }
    .section-stage { min-width:0; }
    .lanes {
      padding:42px 36px;
      display:grid;
      gap:18px;
      background:linear-gradient(180deg, rgba(7,11,16,.86), rgba(9,13,19,.72));
    }
    .lane-card {
      position:relative;
      display:grid;
      grid-template-columns:minmax(0, 1.16fr) 180px 220px;
      align-items:end;
      gap:22px;
      min-height:168px;
      padding:30px 30px 28px;
      border:1px solid var(--line);
      overflow:hidden;
      transition:transform .6s var(--ease), opacity .5s ease, border-color .25s ease;
    }
    .lane-card > div:first-child {
      display:grid;
      align-content:start;
      gap:12px;
    }
    .lane-card::before {
      content:"";
      position:absolute;
      inset:0;
      pointer-events:none;
      background:linear-gradient(120deg, rgba(255,255,255,.02), transparent 22%, transparent 72%, rgba(128,216,255,.04));
    }
    .lane-card::after {
      content:"";
      position:absolute;
      right:26px;
      bottom:24px;
      width:120px;
      height:1px;
      background:currentColor;
      opacity:.26;
    }
    .lane-card.open {
      transform:translate3d(54px, 0, 0) rotate(-1.2deg);
      background:linear-gradient(180deg, rgba(14,21,31,.92), rgba(10,16,24,.96));
      color:var(--text-0);
    }
    .lane-card.paid {
      transform:translate3d(-42px, 0, 0) rotate(.95deg);
      background:linear-gradient(180deg, rgba(27,14,12,.92), rgba(18,12,12,.96));
      color:#fff7f4;
    }
    .lane-card.is-visible { transform:translate3d(0,0,0) rotate(0); }
    .lane-card .tag { background:rgba(255,255,255,.03); }
    .lane-card p {
      margin-top:0;
      max-width:40rem;
      color:var(--text-1);
      font:400 20px/1.08 "Instrument Serif", serif;
    }
    .lane-card.paid p { color:#ffe0d7; }
    .lane-meta {
      font:600 10px/1.6 "IBM Plex Mono", ui-monospace, monospace;
      letter-spacing:.2em;
      text-transform:uppercase;
      color:inherit;
      opacity:.72;
    }
    .lane-price {
      justify-self:end;
      font:800 28px/.92 "Big Shoulders Display", sans-serif;
      text-transform:uppercase;
    }
    .chamber {
      background:
        radial-gradient(circle at 22% 14%, rgba(128,216,255,.08), transparent 20%),
        radial-gradient(circle at 78% 12%, rgba(255,107,66,.07), transparent 16%),
        linear-gradient(180deg, rgba(8,12,17,.98), rgba(7,11,16,.98));
    }
    .chamber-grid {
      padding:42px 36px;
      display:grid;
      grid-template-columns:minmax(0, 1fr) 360px;
      gap:26px;
    }
    .target-stack {
      display:grid;
      gap:18px;
    }
    .target-card {
      position:relative;
      padding:30px 30px 32px;
      border:1px solid var(--line);
      background:linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.015));
      box-shadow:0 24px 80px rgba(0,0,0,.26);
      transition:transform .26s ease, border-color .26s ease, box-shadow .26s ease;
      display:grid;
      align-content:start;
      gap:12px;
    }
    .target-card:nth-child(2) { margin-left:34px; }
    .target-card:nth-child(3) { margin-left:68px; }
    .target-card:hover {
      transform:translate(-8px, -8px);
      border-color:rgba(128,216,255,.24);
      box-shadow:0 32px 90px rgba(0,0,0,.34);
    }
    .target-card p {
      margin-top:0;
      max-width:38rem;
      color:#dce6f2;
      font:400 20px/1.1 "Instrument Serif", serif;
    }
    .note-row {
      display:flex;
      flex-wrap:wrap;
      gap:10px;
      margin-top:0;
      font:600 10px/1.4 "IBM Plex Mono", ui-monospace, monospace;
      letter-spacing:.18em;
      text-transform:uppercase;
      color:var(--text-2);
    }
    .watch-rail {
      border:1px solid var(--line);
      background:linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.01));
    }
    .watch-head {
      padding:30px 24px;
      border-bottom:1px solid var(--line);
      display:grid;
      align-content:start;
      gap:14px;
    }
    .watch-head p {
      margin-top:0;
      color:#d8e1ed;
      font:400 20px/1.08 "Instrument Serif", serif;
    }
    .watch-row {
      padding:22px 24px 24px;
      border-bottom:1px solid rgba(255,255,255,.08);
      transition:background .24s ease, transform .24s ease;
      display:grid;
      align-content:start;
      gap:12px;
    }
    .watch-row:hover { background:rgba(128,216,255,.05); transform:translateX(8px); }
    .watch-row:last-child { border-bottom:none; }
    .watch-row p {
      margin-top:0;
      color:var(--text-1);
      font:400 18px/1.12 "Instrument Serif", serif;
    }
    .dispatch {
      background:linear-gradient(180deg, rgba(9,13,19,.98), rgba(12,16,22,.98));
    }
    .dispatch-grid {
      padding:42px 36px;
      display:grid;
      gap:18px;
    }
    .prompt-card {
      position:relative;
      display:grid;
      grid-template-columns:240px minmax(0, 1fr);
      gap:24px;
      padding:30px 30px 32px;
      border:1px solid var(--line);
      background:linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.01));
      box-shadow:0 24px 80px rgba(0,0,0,.22);
      transition:transform .55s var(--ease), opacity .45s ease, box-shadow .22s ease;
    }
    .prompt-side,
    .prompt-copy {
      display:grid;
      align-content:start;
      gap:12px;
    }
    .prompt-card:nth-child(odd) { transform:translateX(42px); }
    .prompt-card:nth-child(even) { transform:translateX(-30px); }
    .prompt-card.is-visible { transform:translateX(0); }
    .prompt-card:hover { box-shadow:0 34px 96px rgba(0,0,0,.3); }
    .prompt-side strong {
      display:block;
      color:var(--cyan);
      font:600 10px/1.25 "IBM Plex Mono", ui-monospace, monospace;
      letter-spacing:.22em;
      text-transform:uppercase;
    }
    .prompt-side h3 { margin-top:0; }
    .prompt-copy p {
      color:#d6e0ec;
      font:400 20px/1.1 "Instrument Serif", serif;
    }
    .kernel {
      background:linear-gradient(180deg, rgba(5,7,10,.98), rgba(7,10,14,.98));
    }
    .kernel-grid {
      padding:42px 36px;
      display:grid;
      grid-template-columns:minmax(0, 1fr) 380px;
      gap:24px;
    }
    .console-stack {
      display:grid;
      gap:18px;
    }
    .console {
      padding:30px 30px 32px;
      border:1px solid var(--line);
      background:linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.01));
      display:grid;
      align-content:start;
      gap:14px;
    }
    .console p, .console .foot {
      margin-top:0;
      color:var(--text-1);
      font:500 12px/1.75 "IBM Plex Mono", ui-monospace, monospace;
    }
    .discovery-stack {
      display:grid;
      gap:14px;
    }
    .discovery-link {
      display:block;
      padding:24px 22px;
      border:1px solid var(--line);
      background:linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.01));
      transition:transform .24s ease, border-color .24s ease, background .24s ease;
      display:grid;
      align-content:start;
      gap:12px;
    }
    .discovery-link:hover {
      transform:translate(8px, -6px);
      border-color:rgba(128,216,255,.24);
      background:rgba(128,216,255,.05);
    }
    .discovery-link span {
      display:block;
      margin-top:0;
      color:var(--text-1);
      font:500 12px/1.72 "IBM Plex Mono", ui-monospace, monospace;
    }
    .exit {
      display:grid;
      grid-template-columns:minmax(0, 1.06fr) minmax(340px, .94fr);
      border-top:1px solid var(--line);
      background:linear-gradient(180deg, rgba(8,12,17,.98), rgba(6,10,14,.98));
    }
    .exit-copy {
      position:relative;
      padding:34px clamp(24px, 4vw, 64px);
      border-right:1px solid var(--line);
      display:grid;
      align-content:start;
      gap:16px;
    }
    .exit-copy::after {
      content:"RESOLVE";
      position:absolute;
      right:20px;
      bottom:16px;
      font:italic 400 clamp(70px, 7vw, 140px)/.84 "Instrument Serif", serif;
      color:rgba(255,255,255,.05);
    }
    .exit-copy p {
      position:relative;
      z-index:1;
      max-width:34rem;
      margin-top:0;
      color:#dce4ef;
      font:400 22px/1.08 "Instrument Serif", serif;
    }
    .exit-call {
      padding:34px 28px;
      background:linear-gradient(180deg, rgba(255,107,66,.22), rgba(255,107,66,.12));
      display:grid;
      align-content:start;
      gap:14px;
    }
    .exit-call p {
      margin-top:0;
      color:#ffe4dd;
      font:500 12px/1.8 "IBM Plex Mono", ui-monospace, monospace;
    }
    .reveal { opacity:0; filter:blur(8px); }
    .reveal.is-visible { opacity:1; filter:blur(0); }
    @keyframes trace { to { stroke-dashoffset:0; } }
    @media (max-width:1320px) {
      .hero, .chamber-grid, .kernel-grid, .exit { grid-template-columns:1fr; }
      .hero-copy, .exit-copy { border-right:none; border-bottom:1px solid var(--line); }
      .hero { min-height:auto; }
      .hero::before { background:linear-gradient(180deg, rgba(6,9,13,.8) 0 62%, rgba(11,16,22,.98) 62% 100%); }
      .rail-links { grid-template-columns:1fr; }
      .rail-links a { border-right:1px solid rgba(255,255,255,.08); border-bottom:none; }
      .target-card:nth-child(2), .target-card:nth-child(3) { margin-left:0; }
      .metric-rack { grid-template-columns:repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width:1120px) {
      .split { grid-template-columns:1fr; }
      .section-label {
        position:relative;
        top:auto;
        min-height:auto;
        border-right:none;
        border-bottom:1px solid var(--line);
      }
      .lane-card, .prompt-card { grid-template-columns:1fr; }
      .lane-price { justify-self:start; }
      .command-grid, .hero-footer { grid-template-columns:1fr; }
      .hero-footer span { border-right:none; }
      .progress { display:none; }
    }
    @media (max-width:820px) {
      .shell { width:min(100vw - 16px, 1700px); padding:8px 0 44px; }
      .topline, .metric-rack { grid-template-columns:1fr; }
      .topline div, .metric-cell { border-right:none; }
      .hero-copy, .rail-head, .rail-intro, .rail-stack, .section-label, .lanes, .chamber-grid, .dispatch-grid, .kernel-grid, .exit-copy, .exit-call { padding-left:18px; padding-right:18px; }
      h1 { font-size:clamp(62px, 19vw, 114px); max-width:100%; }
      h2 { font-size:clamp(34px, 12vw, 58px); }
      .lede { font-size:clamp(22px, 7vw, 30px); }
      .headline .shift { margin-left:0; }
      .hero-copy::after { width:54vw; height:54vw; right:4%; top:18%; }
      .vault-svg { left:8px; right:8px; bottom:16px; width:auto; height:220px; }
      .lane-card.open, .lane-card.paid, .prompt-card:nth-child(odd), .prompt-card:nth-child(even) { transform:none; }
      .lane-card.is-visible, .prompt-card.is-visible { transform:none; }
    }
  </style>
</head>
<body>
  <nav class="progress" aria-label="Page progress">
    <a href="#vault" data-target="vault" class="active">Vault</a>
    <a href="#lanes" data-target="lanes">Lanes</a>
    <a href="#pressure" data-target="pressure">Pressure</a>
    <a href="#dispatch" data-target="dispatch">Dispatch</a>
    <a href="#kernel" data-target="kernel">Kernel</a>
  </nav>
  <div class="shell">
    <div class="deck">
      <div class="topline">
        <div><strong>Vault protocol</strong><span class="accent">Issue 005</span> / command center</div>
        <div><strong>Coverage</strong>bitcoin / stacks / x402 / AIBTC</div>
        <div><strong>Live sync</strong>${escapeHtml(snapshot.generatedAt)}</div>
        <div><strong>Mode</strong>cinematic vault / protocol control</div>
      </div>

      <section class="hero" id="vault" data-scene="vault">
        <article class="hero-copy">
          <svg class="vault-svg" viewBox="0 0 980 480" aria-hidden="true">
            <circle class="halo" cx="292" cy="240" r="90" />
            <circle class="halo" cx="292" cy="240" r="150" />
            <circle class="halo" cx="292" cy="240" r="212" />
            <path class="trace-back" d="M36 368C134 352 174 282 258 246C330 216 420 226 510 214C626 198 686 126 792 108C860 96 912 118 946 156" />
            <path class="trace-front" d="M36 368C134 352 174 282 258 246C330 216 420 226 510 214C626 198 686 126 792 108C860 96 912 118 946 156" />
            <path class="trace-alt" d="M258 246C322 314 392 352 458 352C560 352 642 268 742 268" />
            <circle class="node" cx="258" cy="246" r="10" />
            <circle class="node" cx="510" cy="214" r="10" />
            <circle class="node" cx="792" cy="108" r="10" />
            <line class="halo" x1="36" y1="418" x2="946" y2="418" />
          </svg>
          <div class="hero-bar">
            <div>
              <div class="kicker">Satsmith protocol desk</div>
              <div class="support">A cinematic vault for operators who need the system before they trust the story.</div>
            </div>
            <div class="tag">Protocol command center</div>
          </div>
          <div>
            <h1 class="headline"><span>Open the vault.</span><span class="shift">Route the</span><span>signal.</span><span class="shift">Kill the</span><span>guesswork.</span></h1>
            <div class="lede">Satsmith is an operator-grade intelligence and debug surface for AIBTC builders who need trust checks, wallet-auth triage, and technical leverage before they waste time, trust, or sats.</div>
            <div class="support">The opening act should feel like a command room, not a product hero. Humans scan it like a restricted control surface. Agents read it like a live protocol map.</div>
          </div>
          <div>
            <div class="metric-rack">
              ${vaultMetrics.map((metric) => `
                <article class="metric-cell">
                  <strong>${escapeHtml(metric.value)}</strong>
                  <span>${escapeHtml(metric.label)}</span>
                </article>
              `).join("")}
            </div>
            <div class="command-grid">
              <a class="command-tile" href="${serviceBase}/api/preview"><strong>Open preview</strong><span>Read the public intelligence layer before paying for a narrower answer.</span></a>
              <a class="command-tile" href="${serviceBase}/api/hire"><strong>Open buyer kit</strong><span>Use the highest-converting request shapes instead of vague asks.</span></a>
              <a class="command-tile" href="${serviceBase}/api/counterparty"><strong>Trust screen</strong><span>Pressure-test a repo, builder, or project before you step in.</span></a>
              <a class="command-tile" href="${serviceBase}/api/auth-debug"><strong>Auth triage</strong><span>Debug heartbeat, inbox, signing, and registration flow from one free route.</span></a>
            </div>
          </div>
          <div class="hero-footer">
            <span>AIBTC profile live</span>
            <span>Project board linked</span>
            <span>x402 routes active</span>
            <span>Machine-readable discovery ready</span>
          </div>
        </article>

        <aside class="command-rail">
          <div class="rail-head">
            <div class="kicker">Control rail</div>
            <h2>Three protocol desks. Zero filler.</h2>
          </div>
          <div class="rail-intro">
            <p>This side is the live command rail. It compresses the first buyer questions into desks that can be opened immediately, without scrolling through ordinary marketing blocks.</p>
          </div>
          <div class="rail-stack">
            ${railRoutes.map((product) => `
              <article class="rail-card reveal">
                <div class="tag">${escapeHtml(product.status === "free" ? "Open desk" : "Paid desk")}</div>
                <h3>${escapeHtml(product.name)}</h3>
                <p>${escapeHtml(product.output)}</p>
                <code>${escapeHtml(product.endpoint.replace(serviceBase, ""))}</code>
              </article>
            `).join("")}
          </div>
          <div class="rail-links">
            ${discoveryLinks.map((item) => `
              <a href="${escapeHtml(item.href)}">
                <strong>${escapeHtml(item.title)}</strong>
                <span>${escapeHtml(item.detail)}</span>
              </a>
            `).join("")}
          </div>
        </aside>
      </section>

      <section class="section" id="lanes" data-scene="lanes">
        <div class="split">
          <div class="section-label">
            <div class="kicker">Access lanes</div>
            <h2>Move through open lanes first. Pay only when the route earns it.</h2>
            <p>This act is the access grid. No pricing table, no feature-grid residue. Each lane is a corridor with a role, a route, and a cost state.</p>
          </div>
          <div class="section-stage lanes">
            ${routeBands.map((product) => `
              <article class="lane-card ${product.tone} reveal">
                <div>
                  <div class="tag">${escapeHtml(product.tag)}</div>
                  <h3>${escapeHtml(product.name)}</h3>
                  <p>${escapeHtml(product.output)}</p>
                  <code>${escapeHtml(product.endpoint.replace(serviceBase, ""))}</code>
                </div>
                <div class="lane-meta">${escapeHtml(product.tone === "open" ? "Read or use immediately" : "x402 payment gate")}</div>
                <div class="lane-price">${escapeHtml(product.price)}</div>
              </article>
            `).join("")}
          </div>
        </div>
      </section>
      <section class="section chamber" id="pressure" data-scene="pressure">
        <div class="split">
          <div class="section-label">
            <div class="kicker">Pressure chamber</div>
            <h2>Where the market is pressurizing into real work.</h2>
            <p>This chamber is about pressure and urgency, not catalogs. Left side ranks the likely openings. Right side tracks the operators who are visibly moving.</p>
            <div class="note-row">
              ${chamberNotes.map((note) => `<span>${escapeHtml(note.label)} / ${escapeHtml(note.value)}</span>`).join("")}
            </div>
          </div>
          <div class="section-stage chamber-grid">
            <div class="target-stack">
              ${top.map((project) => `
                <article class="target-card reveal">
                  <div class="tag">Pressure target</div>
                  <h3>${escapeHtml(project.title)}</h3>
                  <p>${escapeHtml(project.reason)} ${escapeHtml(project.firstMove)}</p>
                  <div class="note-row">
                    <span>${escapeHtml(project.status)}</span>
                    <span>score ${project.score}</span>
                    <span>${escapeHtml(project.angle)}</span>
                  </div>
                </article>
              `).join("")}
            </div>
            <aside class="watch-rail">
              <div class="watch-head">
                <div class="kicker">Builder watch</div>
                <h3>Operators currently throwing signal.</h3>
                <p>The watch rail is the market pulse: fewer modules, harder contrast, tighter judgment.</p>
              </div>
              ${watch.map((entry) => `
                <article class="watch-row reveal">
                  <h3>${escapeHtml(entry.displayName)}</h3>
                  <p>${escapeHtml(entry.description)}</p>
                  <div class="note-row"><span>leaderboard ${entry.score}</span></div>
                </article>
              `).join("")}
            </aside>
          </div>
        </div>
      </section>

      <section class="section dispatch" id="dispatch" data-scene="dispatch">
        <div class="split">
          <div class="section-label">
            <div class="kicker">Dispatch console</div>
            <h2>Give the command in the shape real work takes.</h2>
            <p>The buyer act should not sound like marketing copy. It should sound like a command queue, a brief, or an escalation path that already resembles the paid answer.</p>
          </div>
          <div class="section-stage dispatch-grid">
            ${buyerPrompts.map((item) => `
              <article class="prompt-card reveal">
                <div class="prompt-side">
                  <strong>Dispatch prompt</strong>
                  <h3>${escapeHtml(item.title)}</h3>
                </div>
                <div class="prompt-copy">
                  <p>${escapeHtml(item.useWhen)}</p>
                  <code>${escapeHtml(item.prompt)}</code>
                </div>
              </article>
            `).join("")}
          </div>
        </div>
      </section>

      <section class="section kernel" id="kernel" data-scene="kernel">
        <div class="split">
          <div class="section-label">
            <div class="kicker">Kernel</div>
            <h2>Readable by humans. Actionable by agents.</h2>
            <p>The closing machine act turns the vault into a protocol surface. Free routes stay obvious. Paid escalation stays deliberate. Discovery stays explicit.</p>
          </div>
          <div class="section-stage kernel-grid">
            <div class="console-stack">
              <article class="console reveal">
                <div class="tag">Start open</div>
                <h3>Use the free routes before you buy depth.</h3>
                <pre>GET ${serviceBase}/api/preview
GET ${serviceBase}/api/hire

POST ${serviceBase}/api/counterparty
{
  "target": "Tiny Marten"
}

POST ${serviceBase}/api/auth-debug
{
  "flow": "heartbeat",
  "address": "SP...",
  "message": "AIBTC Check-In | 2026-04-10T13:30:00Z",
  "signature": "<signature>"
}</pre>
              </article>
              <article class="console reveal">
                <div class="tag">Escalate with intent</div>
                <h3>Pay only when ranked leverage matters.</h3>
                <pre>POST ${serviceBase}/api/project-fit
{
  "focus": "x402 wallet debug",
  "limit": 3
}

POST ${serviceBase}/api/service-map
{
  "niche": "agent infra"
}

GET ${serviceBase}/llms.txt
GET ${serviceBase}/openapi.json</pre>
                <div class="foot">Generated from live AIBTC activity, leaderboard, project-board, and bounty surfaces at ${escapeHtml(snapshot.generatedAt)}.</div>
              </article>
            </div>
            <aside class="discovery-stack">
              ${discoveryLinks.map((item) => `
                <a class="discovery-link reveal" href="${escapeHtml(item.href)}">
                  <strong>${escapeHtml(item.title)}</strong>
                  <span>${escapeHtml(item.detail)}</span>
                  <code>${escapeHtml(item.href.replace(serviceBase, ""))}</code>
                </a>
              `).join("")}
            </aside>
          </div>
        </div>
      </section>

      <section class="exit">
        <div class="exit-copy">
          <div class="kicker">Exit state</div>
          <h2>Start in the vault. Leave with a route.</h2>
          <p>The point of this page is not to look like a startup site with better typography. It is to feel like a restricted command surface: one opening thesis, one lane system, one pressure chamber, one dispatch act, one kernel. Every scene should compress indecision.</p>
        </div>
        <div class="exit-call">
          <div class="tag">Best next move</div>
          <h3>Kill the biggest uncertainty first.</h3>
          <p>If the problem is trust, open counterparty. If the problem is heartbeat, signatures, inbox, or wallet flow, open auth-debug. If the problem is fit, monetization, or targeting, escalate into the paid lanes.</p>
          <a class="command-tile" href="${serviceBase}/api/hire"><strong>Open buyer kit</strong><span>Use the command shapes that already sound like technical work.</span></a>
        </div>
      </section>
    </div>
  </div>
  <script>
    (() => {
      const scenes = Array.from(document.querySelectorAll("[data-scene]"));
      const progressLinks = Array.from(document.querySelectorAll(".progress a"));
      const revealNodes = Array.from(document.querySelectorAll(".reveal"));
      const hero = document.querySelector(".hero-copy");

      const setScene = (name) => {
        progressLinks.forEach((link) => link.classList.toggle("active", link.dataset.target === name));
      };

      const sceneObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setScene(entry.target.dataset.scene || "");
          }
        });
      }, { threshold: 0.48 });

      scenes.forEach((scene) => sceneObserver.observe(scene));

      const revealObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
          }
        });
      }, { threshold: 0.16 });

      revealNodes.forEach((node, index) => {
        node.style.transitionDelay = String(Math.min(index * 36, 220)) + "ms";
        revealObserver.observe(node);
      });

      if (hero) {
        window.addEventListener("pointermove", (event) => {
          const rect = hero.getBoundingClientRect();
          const dx = ((event.clientX - rect.left) / rect.width) - 0.5;
          const dy = ((event.clientY - rect.top) / rect.height) - 0.5;
          hero.style.transform = "translate3d(" + (dx * -12) + "px, " + (dy * -8) + "px, 0)";
        }, { passive: true });

        window.addEventListener("pointerleave", () => {
          hero.style.transform = "";
        }, { passive: true });
      }
    })();
  </script>
</body>
</html>`;
}

async function loadMarketSnapshot(): Promise<MarketSnapshot> {
  const [activityPayload, leaderboardPayload, projectsPayload, bountyPayload] = await Promise.all([
    fetchJson<{ stats?: { totalAgents?: number; activeAgents?: number; totalMessages?: number; totalSatsTransacted?: number } }>(ACTIVITY_URL),
    fetchJson<{ leaderboard?: unknown[] }>(LEADERBOARD_URL),
    fetchJson<{ items?: unknown[] }>(PROJECTS_URL),
    fetchJson<{ stats?: { open_bounties?: number; total_paid_sats?: number } }>(BOUNTY_STATS_URL),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    activity: {
      totalAgents: toNumber(activityPayload.stats?.totalAgents),
      activeAgents: toNumber(activityPayload.stats?.activeAgents),
      totalMessages: toNumber(activityPayload.stats?.totalMessages),
      totalSatsTransacted: toNumber(activityPayload.stats?.totalSatsTransacted),
    },
    leaderboard: normalizeLeaderboard(leaderboardPayload),
    projects: normalizeProjects(projectsPayload),
    bounty: {
      openBounties: toNumber(bountyPayload.stats?.open_bounties),
      publicBountyPayoutSats: toNumber(bountyPayload.stats?.total_paid_sats),
    },
  };
}

async function parseJsonBody<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

function buildPayment(c: Context<{ Bindings: Bindings; Variables: Variables }>) {
  return {
    payer: c.get("x402")?.payerAddress ?? "unknown",
    txId: c.get("x402")?.settleResult?.txId ?? null,
  };
}

app.get("/", async (c) => {
  const serviceBase = new URL(c.req.url).origin;
  const accept = c.req.header("Accept") ?? "";
  if (accept.includes("text/html")) {
    const snapshot = await loadMarketSnapshot();
    return c.html(renderLandingPage(snapshot, serviceBase));
  }
  return c.json({
    ...buildCatalog(serviceBase),
    recipient: c.env.RECIPIENT_ADDRESS ? "configured" : "missing",
  });
});

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    network: c.env.NETWORK || "mainnet",
  });
});

app.get("/llms.txt", (c) => {
  const serviceBase = new URL(c.req.url).origin;
  c.header("Content-Type", "text/plain; charset=utf-8");
  return c.text(buildLlmsTxt(serviceBase));
});

app.get("/openapi.json", (c) => {
  const serviceBase = new URL(c.req.url).origin;
  return c.json(buildOpenApi(serviceBase));
});

app.get("/.well-known/ai-plugin.json", (c) => {
  const serviceBase = new URL(c.req.url).origin;
  return c.json(buildAiPluginManifest(serviceBase));
});

app.get("/api/preview", async (c) => {
  const serviceBase = new URL(c.req.url).origin;
  const snapshot = await loadMarketSnapshot();
  c.header("Cache-Control", "public, max-age=120");
  return c.json({
    generatedAt: snapshot.generatedAt,
    summary: buildSummary(snapshot),
    topOpportunities: buildRankedProjects(snapshot.projects, { limit: FREE_PREVIEW_LIMIT }),
    builderWatch: buildBuilderWatch(snapshot.leaderboard, [], FREE_PREVIEW_LIMIT),
    liveProducts: buildServiceProducts(serviceBase),
    sources: [ACTIVITY_URL, LEADERBOARD_URL, PROJECTS_URL, BOUNTY_STATS_URL],
  });
});

app.get("/api/catalog", (c) => {
  const serviceBase = new URL(c.req.url).origin;
  return c.json(buildCatalog(serviceBase));
});

app.get("/api/examples", (c) => {
  const serviceBase = new URL(c.req.url).origin;
  return c.json({
    generatedAt: new Date().toISOString(),
    examples: {
      preview: {
        method: "GET",
        url: `${serviceBase}/api/preview`,
      },
      hire: {
        method: "GET",
        url: `${serviceBase}/api/hire`,
      },
      counterparty: {
        method: "POST",
        url: `${serviceBase}/api/counterparty`,
        body: {
          target: "Tiny Marten",
        },
      },
      authDebug: {
        method: "POST",
        url: `${serviceBase}/api/auth-debug`,
        body: {
          flow: "registration",
          address: "bc1q...",
          message: "Bitcoin will be the currency of AIs",
          signature: "<signature>",
        },
      },
      digest: {
        method: "POST",
        url: `${serviceBase}/api/digest`,
        body: {
          limit: 5,
          filter: "stacks",
        },
      },
      projectFit: {
        method: "POST",
        url: `${serviceBase}/api/project-fit`,
        body: {
          focus: "x402 wallet debug",
          limit: 3,
        },
      },
      serviceMap: {
        method: "POST",
        url: `${serviceBase}/api/service-map`,
        body: {
          niche: "agent infra",
        },
      },
    },
    notes: [
      "Preview and catalog are free.",
      "Paid routes return x402 payment requirements first.",
      "All paid routes currently settle in sBTC on mainnet.",
    ],
  });
});

app.get("/api/hire", (c) => {
  const serviceBase = new URL(c.req.url).origin;
  return c.json({
    generatedAt: new Date().toISOString(),
    ...buildHireKit(serviceBase),
  });
});

app.get("/api/counterparty", (c) => {
  const serviceBase = new URL(c.req.url).origin;
  return c.json({
    generatedAt: new Date().toISOString(),
    route: `${serviceBase}/api/counterparty`,
    method: "POST",
    description: "Free counterparty due-diligence report for AIBTC projects, builders, and GitHub repos.",
    fields: {
      target: "project title, builder name, or free-text target",
      projectId: "optional exact AIBTC Projects id",
      githubUrl: "optional GitHub repo URL",
      founder: "optional founder or claimant name",
    },
    example: {
      target: "AIBTC Skills",
      githubUrl: "https://github.com/aibtcdev/skills",
    },
  });
});

app.post("/api/counterparty", async (c) => {
  const body = await parseJsonBody<CounterpartyInput>(c.req.raw);
  const snapshot = await loadMarketSnapshot();
  return c.json(await buildCounterpartyReport(snapshot, body));
});

app.get("/api/auth-debug", (c) => {
  const serviceBase = new URL(c.req.url).origin;
  return c.json({
    generatedAt: new Date().toISOString(),
    route: `${serviceBase}/api/auth-debug`,
    method: "POST",
    description: "Free AIBTC wallet-auth and signature triage for registration, heartbeat, inbox, and x402-adjacent auth failures.",
    fields: {
      flow: "registration | heartbeat | inbox-read | inbox-reply | x402",
      address: "BTC or STX signer address",
      chain: "optional: btc | stx",
      message: "exact signed message",
      signature: "signed payload string",
      context: "optional failure note or expected behavior",
    },
    example: {
      flow: "registration",
      address: "bc1q...",
      message: "Bitcoin will be the currency of AIs",
      signature: "<signature>",
      context: "register endpoint says signature invalid",
    },
  });
});

app.post("/api/auth-debug", async (c) => {
  const body = await parseJsonBody<AuthDebugInput>(c.req.raw);
  return c.json(buildAuthDebug(body));
});

app.post(
  "/api/digest",
  x402Middleware({
    amount: SERVICE_PRICE_SATS,
    tokenType: "sBTC",
  }),
  async (c) => {
    const serviceBase = new URL(c.req.url).origin;
    const body = await parseJsonBody<{ limit?: number; filter?: string }>(c.req.raw);
    const limit = Math.max(1, Math.min(10, toNumber(body.limit, 5)));
    const filter = String(body.filter ?? "").trim().toLowerCase();
    const snapshot = await loadMarketSnapshot();

    return c.json({
      generatedAt: snapshot.generatedAt,
      filter: filter || null,
      summary: buildSummary(snapshot),
      opportunities: buildRankedProjects(snapshot.projects, { limit, filter }),
      leaderboardWatch: buildBuilderWatch(snapshot.leaderboard, extractFocusTerms(filter), 3),
      serviceGaps: buildServiceGaps(snapshot.projects),
      liveProducts: buildServiceProducts(serviceBase),
      sources: [ACTIVITY_URL, LEADERBOARD_URL, PROJECTS_URL, BOUNTY_STATS_URL],
      payment: buildPayment(c),
    });
  },
);

app.post(
  "/api/project-fit",
  x402Middleware({
    amount: SERVICE_PRICE_SATS,
    tokenType: "sBTC",
  }),
  async (c) => {
    const serviceBase = new URL(c.req.url).origin;
    const body = await parseJsonBody<{ focus?: string; limit?: number }>(c.req.raw);
    const focus = String(body.focus ?? "").trim();
    const limit = Math.max(1, Math.min(8, toNumber(body.limit, 5)));
    const focusTerms = extractFocusTerms(focus);
    const snapshot = await loadMarketSnapshot();
    const bestMatches = buildRankedProjects(snapshot.projects, {
      limit,
      filter: focus.toLowerCase(),
      focusTerms,
    });

    return c.json({
      generatedAt: snapshot.generatedAt,
      focus: focus || null,
      summary: buildSummary(snapshot),
      bestMatches,
      builderWatch: buildBuilderWatch(snapshot.leaderboard, focusTerms, 3),
      recommendedPitch:
        focusTerms.length
          ? `Offer a tight ${focus} deliverable with a concrete proof-of-work link and a short path to shipping.`
          : "Lead with a bounded technical deliverable, a fast first move, and proof that the work can be shipped quickly.",
      liveProducts: buildServiceProducts(serviceBase),
      sources: [ACTIVITY_URL, LEADERBOARD_URL, PROJECTS_URL, BOUNTY_STATS_URL],
      payment: buildPayment(c),
    });
  },
);

app.post(
  "/api/service-map",
  x402Middleware({
    amount: SERVICE_PRICE_SATS,
    tokenType: "sBTC",
  }),
  async (c) => {
    const serviceBase = new URL(c.req.url).origin;
    const body = await parseJsonBody<{ niche?: string }>(c.req.raw);
    const niche = String(body.niche ?? "").trim();
    const focusTerms = extractFocusTerms(niche);
    const snapshot = await loadMarketSnapshot();
    const bestMatches = buildRankedProjects(snapshot.projects, {
      limit: 4,
      filter: niche.toLowerCase(),
      focusTerms,
    });

    return c.json({
      generatedAt: snapshot.generatedAt,
      niche: niche || null,
      liveProducts: buildServiceProducts(serviceBase),
      nextAdjacentProducts: buildServiceGaps(snapshot.projects),
      bestProofTargets: bestMatches,
      monetizationHooks: [
        "Turn repeated operator questions into a paid endpoint before turning them into bespoke labor.",
        "Use public deliverables and AIBTC Projects links as trust anchors for inbound conversion.",
        "Bundle engineering work with diagnostics, verification, or market intelligence when the buyer needs speed.",
      ],
      sources: [ACTIVITY_URL, LEADERBOARD_URL, PROJECTS_URL, BOUNTY_STATS_URL],
      payment: buildPayment(c),
    });
  },
);

export default app;


