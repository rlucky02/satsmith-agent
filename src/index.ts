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
    ...freeProducts.map((product) => ({ ...product, tag: "Free route", tone: "paper" as const })),
    ...paidProducts.map((product) => ({ ...product, tag: "Paid x402", tone: "void" as const })),
  ];
  const buyerPrompts = hireKit.bestFitRequests.slice(0, 3);
  const discoveryLinks = [
    { title: "llms.txt", href: `${serviceBase}/llms.txt`, detail: "Readable route summary for agents and autonomous clients." },
    { title: "OpenAPI", href: `${serviceBase}/openapi.json`, detail: "Structured schema for wrappers, plugins, and tool use." },
    { title: "AI Plugin", href: `${serviceBase}/.well-known/ai-plugin.json`, detail: "Manifest that points external runtimes at the live schema." },
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Satsmith | Operator Intelligence for AIBTC</title>
  <style>
    @import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Instrument+Serif:ital@0;1&family=Syne:wght@500;700;800&display=swap");
    :root { --paper:#f5efe4; --paper-soft:#fcf7ef; --paper-deep:#e3d8c8; --ink:#11110f; --muted:#5f594f; --line:#13120f; --red:#d93b23; --red-soft:#ff7952; --blue:#8ea7ff; --gold:#f0c876; --void:#0d1014; --void-soft:#171b22; --chalk:#fff9f1; }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; }
    body { margin:0; color:var(--ink); font-family:"Syne",sans-serif; min-height:100vh; background:radial-gradient(circle at 10% 12%, rgba(217,59,35,.2), transparent 22%), radial-gradient(circle at 88% 14%, rgba(142,167,255,.18), transparent 18%), radial-gradient(circle at 56% 76%, rgba(240,200,118,.12), transparent 20%), linear-gradient(180deg,#faf4e8 0%,#ede3d2 58%,#f4ede0 100%); scroll-snap-type:y proximity; }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; background:linear-gradient(rgba(17,17,15,.04) 1px, transparent 1px), linear-gradient(90deg, rgba(17,17,15,.04) 1px, transparent 1px); background-size:76px 76px; opacity:.34; mask-image:linear-gradient(180deg, rgba(0,0,0,.94), rgba(0,0,0,.56) 72%, transparent 100%); }
    body::after { content:""; position:fixed; inset:0; pointer-events:none; background:radial-gradient(circle at center, transparent 58%, rgba(0,0,0,.1) 100%), linear-gradient(180deg, rgba(255,255,255,.28), transparent 16%, transparent 84%, rgba(0,0,0,.08)); mix-blend-mode:multiply; opacity:.72; }
    a { color:inherit; text-decoration:none; }
    .wrap { width:min(1660px, calc(100vw - 44px)); margin:0 auto; padding:22px 0 96px; }
    .paper { position:relative; overflow:hidden; border:1.5px solid var(--line); background:linear-gradient(180deg, rgba(255,255,255,.58), rgba(255,255,255,.2)), var(--paper); box-shadow:0 28px 120px rgba(17,15,12,.18); }
    .paper::before { content:""; position:absolute; inset:0; pointer-events:none; background:linear-gradient(110deg, rgba(217,59,35,.07), transparent 18%), linear-gradient(300deg, rgba(142,167,255,.08), transparent 22%), radial-gradient(circle at 74% 16%, rgba(255,255,255,.34), transparent 24%); }
    .paper::after { content:""; position:absolute; inset:0; pointer-events:none; background-image:linear-gradient(rgba(17,17,15,.03) 1px, transparent 1px), linear-gradient(90deg, rgba(17,17,15,.03) 1px, transparent 1px); background-size:148px 148px; opacity:.24; }
    .progress { position:fixed; left:26px; bottom:26px; z-index:60; display:grid; gap:8px; }
    .progress a { display:flex; align-items:center; gap:12px; color:rgba(17,17,15,.46); font:600 10px/1 "IBM Plex Mono",ui-monospace,monospace; letter-spacing:.22em; text-transform:uppercase; transition:color .22s ease, transform .22s ease; }
    .progress a::before { content:""; width:9px; height:9px; border:1px solid currentColor; background:transparent; transition:background .22s ease, transform .22s ease; }
    .progress a::after { content:""; width:34px; height:1px; background:currentColor; opacity:.6; }
    .progress a.active { color:var(--line); transform:translateX(6px); }
    .progress a.active::before { background:var(--red); border-color:var(--red); transform:scale(1.2); }
    .ticker { position:relative; z-index:2; display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); border-bottom:1.5px solid var(--line); background:rgba(255,249,241,.78); backdrop-filter:blur(12px); }
    .ticker div { padding:14px 18px 13px; border-right:1.5px solid var(--line); font:600 10px/1.5 "IBM Plex Mono",ui-monospace,monospace; letter-spacing:.22em; text-transform:uppercase; }
    .ticker div:last-child { border-right:none; }
    .ticker strong { display:block; margin-bottom:4px; color:var(--red); }
    .cover { position:relative; z-index:1; display:grid; grid-template-columns:minmax(0, 1.24fr) minmax(340px, .76fr); min-height:102svh; border-bottom:1.5px solid var(--line); }
    .cover::before { content:""; position:absolute; inset:0; pointer-events:none; background:linear-gradient(90deg, transparent 0 62%, rgba(13,16,20,.97) 62% 100%), linear-gradient(180deg, transparent 0 80%, rgba(17,17,15,.08) 80% 100%); }
    .cover-copy { position:relative; padding:34px clamp(24px, 4vw, 60px) 28px; border-right:1.5px solid var(--line); display:grid; grid-template-rows:auto 1fr auto auto; }
    .cover-copy::before { content:"ISSUE"; position:absolute; right:14%; bottom:30%; font:italic 400 clamp(76px, 9vw, 144px)/.82 "Instrument Serif",serif; letter-spacing:-.04em; color:rgba(17,17,15,.05); transform:rotate(-4deg); pointer-events:none; }
    .cover-copy::after { content:""; position:absolute; right:8%; top:12%; width:min(36vw, 460px); height:min(30vw, 360px); border:1.5px solid rgba(17,17,15,.16); border-radius:999px; transform:rotate(-14deg); background:radial-gradient(circle at center, rgba(217,59,35,.12), transparent 68%); pointer-events:none; }
    .cover-trace { position:absolute; left:clamp(28px, 4vw, 62px); bottom:7%; width:min(58vw, 840px); height:min(44vh, 420px); pointer-events:none; opacity:.9; }
    .cover-trace path { fill:none; stroke-linecap:round; stroke-linejoin:round; }
    .cover-trace .trace-back { stroke:rgba(17,17,15,.08); stroke-width:14; }
    .cover-trace .trace-front { stroke:var(--red); stroke-width:4; stroke-dasharray:1200; stroke-dashoffset:1200; animation:draw 3s cubic-bezier(.22,1,.36,1) .2s forwards; }
    .cover-trace .trace-node { fill:var(--chalk); stroke:var(--line); stroke-width:2; }
    .eyebrow, .route-tag, .list-tag, .metric-label { display:inline-flex; align-items:center; justify-content:center; padding:8px 12px; border:1px solid currentColor; font:600 10px/1 "IBM Plex Mono",ui-monospace,monospace; letter-spacing:.2em; text-transform:uppercase; }
    .eyebrow { width:max-content; color:var(--red); background:rgba(255,249,241,.72); }
    .stamp { display:inline-flex; align-items:center; justify-content:center; padding:12px 14px; background:var(--line); color:var(--chalk); font:600 10px/1 "IBM Plex Mono",ui-monospace,monospace; letter-spacing:.22em; text-transform:uppercase; border:1px solid var(--line); box-shadow:12px 12px 0 rgba(217,59,35,.15); }
    .cover-top { position:relative; z-index:1; display:flex; justify-content:space-between; gap:18px; align-items:flex-start; }
    h1, h2, h3 { margin:0; letter-spacing:-.05em; }
    h1 { position:relative; z-index:1; margin-top:38px; font:800 clamp(60px, 8.2vw, 136px)/.84 "Syne",sans-serif; text-transform:uppercase; }
    h2 { font:800 clamp(36px, 4.6vw, 72px)/.9 "Syne",sans-serif; text-transform:uppercase; }
    h3 { font:700 clamp(24px, 2.2vw, 34px)/.94 "Syne",sans-serif; text-transform:uppercase; }
    p { margin:0; }
    .deck { position:relative; z-index:1; max-width:620px; margin-top:24px; font:400 clamp(24px, 2.15vw, 32px)/1.08 "Instrument Serif",serif; color:#191712; }
    .subdeck { position:relative; z-index:1; max-width:620px; margin-top:18px; font:500 13px/1.82 "IBM Plex Mono",ui-monospace,monospace; letter-spacing:.03em; color:#4d483f; }
    .stats-strip { position:relative; z-index:1; display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); margin-top:44px; border-top:1.5px solid var(--line); }
    .metric { padding:22px 14px 24px; border-right:1.5px solid var(--line); border-bottom:1.5px solid var(--line); background:rgba(255,249,241,.46); }
    .metric:last-child { border-right:none; }
    .metric strong { display:block; font:800 clamp(38px, 4vw, 64px)/.88 "Syne",sans-serif; }
    .metric-label { margin-top:10px; color:var(--muted); width:max-content; background:rgba(17,17,15,.04); }
    .action-row { position:relative; z-index:1; display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); margin-top:18px; border-left:1.5px solid var(--line); }
    .action { min-height:152px; padding:24px 22px 20px; border-right:1.5px solid var(--line); border-bottom:1.5px solid var(--line); background:rgba(255,249,241,.48); transition:transform .24s ease, background .24s ease, color .24s ease, box-shadow .24s ease; }
    .action:nth-child(2), .action:nth-child(3) { background:#f2e6d5; }
    .action:nth-child(4) { background:#ebdfcf; }
    .action:hover { transform:translate(-6px, -6px); box-shadow:10px 10px 0 rgba(17,17,15,.9); background:var(--line); color:var(--chalk); }
    .action strong { display:block; max-width:12ch; font:700 28px/.92 "Syne",sans-serif; text-transform:uppercase; }
    .action span { display:block; max-width:24ch; margin-top:14px; font:500 12px/1.75 "IBM Plex Mono",ui-monospace,monospace; opacity:.9; }
    .issue-note { position:relative; z-index:1; display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); }
    .issue-note span { padding:12px 14px; border-right:1.5px solid var(--line); border-bottom:1.5px solid var(--line); font:600 10px/1.45 "IBM Plex Mono",ui-monospace,monospace; letter-spacing:.22em; text-transform:uppercase; background:rgba(255,249,241,.72); }
    .issue-note span:nth-child(2n) { border-right:none; }
    .tower { position:relative; display:grid; grid-template-rows:auto auto 1fr auto; background:linear-gradient(180deg, rgba(13,16,20,.98), rgba(21,25,31,.98)); color:var(--chalk); }
    .tower::before { content:"FIELD"; position:absolute; right:8px; top:54px; font:italic 400 clamp(68px, 8vw, 128px)/.84 "Instrument Serif",serif; color:rgba(255,255,255,.08); transform:rotate(-90deg) translateX(-34%); transform-origin:right top; pointer-events:none; }
    .tower > * { padding:30px 28px 0; }
    .tower h2 { max-width:8ch; color:#fff5e8; }
    .tower p { color:#c1b6a6; }
    .tower-stack { margin-top:28px; display:grid; gap:16px; padding-bottom:16px; }
    .tower-card { padding:22px 22px 24px; border:1px solid rgba(255,255,255,.11); background:linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.01)); }
    .tower-card strong { display:block; margin-bottom:12px; color:var(--gold); font:600 10px/1.2 "IBM Plex Mono",ui-monospace,monospace; letter-spacing:.22em; text-transform:uppercase; }
    .tower-card h3 { color:#fff7ed; max-width:12ch; }
    .tower-card p { margin-top:12px; font:400 18px/1.16 "Instrument Serif",serif; color:#e5d8c9; }
    .tower-card code, .route-band code, .prompt-card code, .console pre, .discovery a code { display:inline-block; margin-top:16px; padding:10px 12px; font:500 12px/1.58 "IBM Plex Mono",ui-monospace,monospace; border:1px solid currentColor; word-break:break-word; background:rgba(255,255,255,.03); }
    .tower-links { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); margin:28px; border:1px solid rgba(255,255,255,.14); }
    .tower-links a { padding:18px 16px; border-right:1px solid rgba(255,255,255,.14); transition:background .2s ease, transform .2s ease; }
    .tower-links a:hover { background:rgba(255,255,255,.05); transform:translateY(-3px); }
    .tower-links a:last-child { border-right:none; }
    .tower-links strong { display:block; font:700 22px/.94 "Syne",sans-serif; text-transform:uppercase; }
    .tower-links span { display:block; margin-top:8px; color:#bfb29f; font:500 12px/1.68 "IBM Plex Mono",ui-monospace,monospace; }
    .tower-foot { margin:28px; padding:18px; border:1px solid rgba(255,255,255,.18); background:linear-gradient(135deg, rgba(217,59,35,.18), rgba(240,200,118,.12)); }
    .tower-foot strong { display:block; color:#fff1cc; font:600 10px/1.1 "IBM Plex Mono",ui-monospace,monospace; letter-spacing:.22em; text-transform:uppercase; }
    .tower-foot p { margin-top:10px; font:400 clamp(28px, 2.8vw, 42px)/.94 "Instrument Serif",serif; color:#fff7ee; }
    .scene, .cover, .closing { scroll-snap-align:start; }
    .scene { position:relative; z-index:1; border-top:1.5px solid var(--line); }
    .scene:nth-of-type(odd) { background:rgba(255,249,241,.54); }
    .scene-head { display:grid; grid-template-columns:340px minmax(0, 1fr); }
    .scene-label { padding:28px 24px; border-right:1.5px solid var(--line); background:linear-gradient(180deg, rgba(255,249,241,.64), rgba(242,231,214,.7)); }
    .scene-label p { margin-top:18px; color:var(--muted); font:400 18px/1.18 "Instrument Serif",serif; max-width:14ch; }
    .scene-body { min-width:0; }
    .bands { display:grid; gap:18px; padding:24px; }
    .route-band { position:relative; display:grid; grid-template-columns:minmax(0, 1.2fr) 180px 220px; align-items:end; gap:24px; min-height:164px; padding:26px 26px 24px; border:1.5px solid var(--line); transition:transform .7s cubic-bezier(.22,1,.36,1), opacity .55s ease, filter .55s ease, box-shadow .3s ease; }
    .route-band::after { content:""; position:absolute; inset:auto 24px 24px auto; width:96px; height:1px; background:currentColor; opacity:.35; }
    .route-band:nth-child(odd) { transform:translate3d(56px, 0, 0) rotate(-1.4deg); }
    .route-band:nth-child(even) { transform:translate3d(-36px, 0, 0) rotate(.95deg); }
    .route-band.paper { background:#fbf6ee; color:var(--ink); box-shadow:16px 16px 0 rgba(17,17,15,.08); }
    .route-band.void { background:linear-gradient(180deg, var(--void), var(--void-soft)); color:var(--chalk); box-shadow:18px 18px 0 rgba(17,17,15,.18); }
    .route-band.is-visible { transform:translate3d(0,0,0) rotate(0); }
    .route-band .route-tag { width:max-content; background:rgba(17,17,15,.05); }
    .route-band.paper .route-tag { color:var(--red); }
    .route-band.void .route-tag { color:var(--gold); background:rgba(255,255,255,.05); }
    .route-band .route-meta { font:600 10px/1.5 "IBM Plex Mono",ui-monospace,monospace; letter-spacing:.2em; text-transform:uppercase; opacity:.72; }
    .route-band .route-price { justify-self:end; font:700 28px/.92 "Syne",sans-serif; text-transform:uppercase; }
    .pressure { display:grid; grid-template-columns:minmax(0, 1fr) 390px; }
    .pressure-main { padding:24px; border-right:1.5px solid var(--line); display:grid; gap:18px; }
    .pressure-main .feature { padding:28px 28px 30px; border:1.5px solid var(--line); background:rgba(255,249,241,.5); box-shadow:16px 16px 0 rgba(17,17,15,.08); transition:transform .65s cubic-bezier(.22,1,.36,1), opacity .5s ease, filter .5s ease, box-shadow .3s ease; }
    .pressure-main .feature:nth-child(2) { margin-left:34px; background:#f2e7d7; }
    .pressure-main .feature:nth-child(3) { margin-left:68px; background:#ebdece; }
    .pressure-main .feature:hover { transform:translate(-8px, -8px); box-shadow:20px 20px 0 rgba(17,17,15,.15); }
    .feature p { margin-top:14px; max-width:36rem; color:var(--muted); font:400 18px/1.2 "Instrument Serif",serif; }
    .meta { display:flex; flex-wrap:wrap; gap:10px; margin-top:18px; font:600 10px/1.3 "IBM Plex Mono",ui-monospace,monospace; letter-spacing:.18em; text-transform:uppercase; color:var(--muted); }
    .pressure-rail { background:linear-gradient(180deg, var(--void), #0f1318); color:var(--chalk); }
    .pressure-rail .rail-head { padding:28px 26px; border-bottom:1px solid rgba(255,255,255,.12); }
    .pressure-rail .rail-head p { margin-top:14px; color:#d2c6b6; font:400 18px/1.18 "Instrument Serif",serif; }
    .watch-item { padding:22px 26px 24px; border-bottom:1px solid rgba(255,255,255,.12); transition:transform .55s cubic-bezier(.22,1,.36,1), opacity .45s ease, background .25s ease; }
    .watch-item:hover { transform:translateX(8px); background:rgba(255,255,255,.03); }
    .watch-item:last-child { border-bottom:none; }
    .watch-item p { margin-top:12px; color:#cfc3b3; font:400 18px/1.16 "Instrument Serif",serif; }
    .watch-item .meta { color:var(--gold); }
    .prompts { display:grid; grid-template-columns:370px minmax(0, 1fr); }
    .prompt-intro { position:relative; padding:30px 26px; border-right:1.5px solid var(--line); background:linear-gradient(180deg, #ded2bf, #f4ebdd); }
    .prompt-intro::after { content:"BUYER"; position:absolute; left:18px; bottom:22px; font:italic 400 clamp(72px, 7vw, 120px)/.86 "Instrument Serif",serif; color:rgba(17,17,15,.08); }
    .prompt-intro h2 { max-width:6ch; }
    .prompt-intro p { margin-top:16px; color:#413c35; font:400 18px/1.18 "Instrument Serif",serif; max-width:12ch; }
    .prompt-stack { display:grid; gap:18px; padding:24px; }
    .prompt-card { display:grid; grid-template-columns:220px minmax(0, 1fr); gap:22px; padding:26px; border:1.5px solid var(--line); background:rgba(255,249,241,.46); box-shadow:16px 16px 0 rgba(17,17,15,.08); transition:transform .6s cubic-bezier(.22,1,.36,1), opacity .45s ease, box-shadow .25s ease; }
    .prompt-card:nth-child(2) { background:#f3e8d9; }
    .prompt-card:nth-child(3) { background:#eadccc; }
    .prompt-card:nth-child(odd) { transform:rotate(-.9deg); }
    .prompt-card:nth-child(even) { transform:rotate(.75deg); }
    .prompt-card:hover { box-shadow:22px 22px 0 rgba(17,17,15,.13); }
    .prompt-side strong { display:block; font:600 10px/1.3 "IBM Plex Mono",ui-monospace,monospace; letter-spacing:.22em; text-transform:uppercase; color:var(--red); }
    .prompt-side h3 { margin-top:12px; }
    .prompt-card p { color:var(--muted); font:400 18px/1.16 "Instrument Serif",serif; }
    .machine { display:grid; grid-template-columns:minmax(0, 1fr) 380px; background:linear-gradient(180deg, var(--void), #0a0c10); color:var(--chalk); }
    .console-wrap { border-right:1.5px solid rgba(255,255,255,.12); }
    .console-head { padding:30px 28px 0; }
    .console-head p { margin-top:14px; max-width:34rem; color:#d3c7b7; font:400 18px/1.18 "Instrument Serif",serif; }
    .console-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); margin-top:26px; }
    .console { padding:26px 28px; border-top:1px solid rgba(255,255,255,.12); border-right:1px solid rgba(255,255,255,.12); min-height:100%; background:linear-gradient(180deg, rgba(255,255,255,.02), transparent); }
    .console:last-child { border-right:none; }
    .console p, .console .foot { margin-top:14px; color:#bfb39f; font:500 12px/1.75 "IBM Plex Mono",ui-monospace,monospace; }
    .discovery { padding:30px 28px; background:linear-gradient(180deg, #12151a, #171c22); }
    .discovery p { margin-top:14px; color:#d2c6b5; font:400 18px/1.18 "Instrument Serif",serif; }
    .discovery a { display:block; margin-top:18px; padding:18px; border:1px solid rgba(255,255,255,.14); transition:transform .3s ease, background .3s ease, box-shadow .3s ease; }
    .discovery a:hover { transform:translate(8px, -6px); background:rgba(255,255,255,.04); box-shadow:12px 12px 0 rgba(255,255,255,.05); }
    .discovery a strong { display:block; font:700 22px/.94 "Syne",sans-serif; text-transform:uppercase; }
    .discovery a span { display:block; margin-top:10px; color:#cbbfad; font:500 12px/1.72 "IBM Plex Mono",ui-monospace,monospace; }
    .closing { display:grid; grid-template-columns:minmax(0, 1.08fr) minmax(340px, .92fr); border-top:1.5px solid var(--line); }
    .closing-copy { position:relative; padding:34px clamp(24px, 4vw, 56px); background:var(--paper-soft); border-right:1.5px solid var(--line); }
    .closing-copy::after { content:"ENDNOTE"; position:absolute; right:18px; bottom:16px; font:italic 400 clamp(66px, 7vw, 124px)/.84 "Instrument Serif",serif; color:rgba(17,17,15,.07); }
    .closing-copy p { position:relative; z-index:1; margin-top:18px; max-width:34rem; color:#342f29; font:400 21px/1.12 "Instrument Serif",serif; }
    .closing-call { padding:34px 28px; background:linear-gradient(180deg, var(--red), #b82f1b); color:var(--chalk); }
    .closing-call p { margin-top:14px; color:#ffe2d6; font:500 12px/1.75 "IBM Plex Mono",ui-monospace,monospace; }
    .closing-call .action { margin-top:22px; border:1px solid rgba(255,255,255,.26); background:rgba(255,255,255,.1); color:var(--chalk); min-height:auto; box-shadow:none; }
    .closing-call .action:hover { box-shadow:10px 10px 0 rgba(17,17,15,.34); }
    .closing-call .action strong { font-size:26px; }
    .reveal { opacity:0; filter:blur(10px); }
    .reveal.is-visible { opacity:1; filter:blur(0); }
    .cover-top, .cover-copy > div, .tower, .console, .discovery a { animation:rise .8s ease both; }
    .cover-copy > div:nth-child(2) { animation-delay:.08s; }
    .cover-copy > div:nth-child(3) { animation-delay:.14s; }
    .tower { animation-delay:.18s; }
    @keyframes rise { from { opacity:0; transform:translateY(22px); } to { opacity:1; transform:translateY(0); } }
    @keyframes draw { to { stroke-dashoffset:0; } }
    @media (max-width:1320px) { .cover, .pressure, .machine, .closing { grid-template-columns:1fr; } .cover-copy, .pressure-main, .console-wrap, .closing-copy { border-right:none; border-bottom:1.5px solid var(--line); } .cover::before { background:linear-gradient(180deg, transparent 0 66%, rgba(13,16,20,.97) 66% 100%); } .cover-trace { width:min(72vw, 860px); } .tower::before { transform:none; top:auto; bottom:18px; right:18px; } .stats-strip { grid-template-columns:repeat(2, minmax(0, 1fr)); } .ticker { grid-template-columns:repeat(2, minmax(0, 1fr)); } }
    @media (max-width:1120px) { .scene-head, .prompts { grid-template-columns:1fr; } .scene-label, .prompt-intro { border-right:none; border-bottom:1.5px solid var(--line); } .route-band, .prompt-card { grid-template-columns:1fr; } .route-band .route-price { justify-self:start; } .pressure-main .feature:nth-child(2), .pressure-main .feature:nth-child(3) { margin-left:0; } .console-grid { grid-template-columns:1fr; } .console { border-right:none; } }
    @media (max-width:900px) { .progress { display:none; } .wrap { width:min(100vw - 18px, 1660px); padding:10px 0 44px; } .ticker, .action-row, .issue-note, .tower-links, .stats-strip { grid-template-columns:1fr; } .ticker div, .metric, .action, .issue-note span, .tower-links a { border-right:none; } .tower-links a { border-bottom:1px solid rgba(255,255,255,.14); } .tower-links a:last-child { border-bottom:none; } }
    @media (max-width:720px) { .cover-copy, .tower > *, .scene-label, .pressure-main, .pressure-rail .rail-head, .watch-item, .prompt-intro, .prompt-stack, .console-head, .console, .discovery, .closing-copy, .closing-call { padding-left:18px; padding-right:18px; } h1 { max-width:100%; font-size:clamp(60px, 18vw, 112px); } h2 { font-size:clamp(34px, 13vw, 58px); } .deck { font-size:clamp(22px, 8vw, 30px); } .cover-copy::before { top:158px; right:0; font-size:clamp(92px, 28vw, 160px); } .cover-copy::after { width:58vw; height:34vw; right:8%; top:13%; } .cover-trace { left:12px; right:12px; bottom:12px; width:auto; height:180px; } .action { min-height:132px; } .bands, .pressure-main, .prompt-stack { padding:14px; } .machine { grid-template-columns:1fr; } .console-wrap { border-right:none; border-bottom:1.5px solid rgba(255,255,255,.12); } }
  </style>
</head>
<body>
  <nav class="progress" aria-label="Page progress">
    <a href="#cover" data-target="cover" class="active">Cover</a>
    <a href="#routes" data-target="routes">Routes</a>
    <a href="#pressure" data-target="pressure">Pressure</a>
    <a href="#buyer" data-target="buyer">Buyer</a>
    <a href="#machine" data-target="machine">Machine</a>
  </nav>
  <div class="wrap">
    <div class="paper">
      <div class="ticker">
        <div><strong>Field report</strong><br>Issue 004 / operator surface</div>
        <div><strong>Coverage</strong><br>bitcoin / stacks / x402 / AIBTC</div>
        <div><strong>Live sync</strong><br>${escapeHtml(snapshot.generatedAt)}</div>
        <div><strong>Read mode</strong><br>editorial front / technical spine</div>
      </div>

      <section class="cover" id="cover" data-scene="cover">
        <article class="cover-copy">
          <svg class="cover-trace" viewBox="0 0 780 420" aria-hidden="true">
            <path class="trace-back" d="M24 324C140 316 160 184 274 184C362 184 392 254 466 254C580 254 596 82 744 78" />
            <path class="trace-front" d="M24 324C140 316 160 184 274 184C362 184 392 254 466 254C580 254 596 82 744 78" />
            <circle class="trace-node" cx="274" cy="184" r="11" />
            <circle class="trace-node" cx="466" cy="254" r="11" />
            <circle class="trace-node" cx="744" cy="78" r="11" />
          </svg>
          <div class="cover-top">
            <div>
              <div class="eyebrow">AIBTC operator gazette</div>
              <div class="subdeck">A brutal editorial surface for builders who would rather trace the system than believe the pitch.</div>
            </div>
            <div class="stamp">Demand engine</div>
          </div>
          <div>
            <h1>Don't buy<br>the story.<br>Trace the<br>system.</h1>
            <div class="deck">Satsmith is a working operator desk for AIBTC builders who need counterparty diligence, wallet-auth triage, and technical leverage before they waste trust, time, or sats.</div>
            <div class="subdeck">The page should feel like a cover spread, not a dashboard. Humans browse it like a field report. Agents parse it like a tool surface. Buyers start free, then pay only when the answer is worth it.</div>
          </div>
          <div>
            <div class="stats-strip">
              <article class="metric"><strong>${summary.totalAgents.toLocaleString("en-US")}</strong><span class="metric-label">agents watched</span></article>
              <article class="metric"><strong>${summary.activeAgents.toLocaleString("en-US")}</strong><span class="metric-label">active operators</span></article>
              <article class="metric"><strong>${summary.totalMessages.toLocaleString("en-US")}</strong><span class="metric-label">paid messages</span></article>
              <article class="metric"><strong>${summary.totalSatsTransacted.toLocaleString("en-US")}</strong><span class="metric-label">sats traced</span></article>
            </div>
            <div class="action-row">
              <a class="action" href="${serviceBase}/api/preview"><strong>Open preview</strong><span>Read the market first without committing to a paid route.</span></a>
              <a class="action" href="${serviceBase}/api/hire"><strong>Buyer kit</strong><span>Use the exact request shapes that convert into technical work.</span></a>
              <a class="action" href="${serviceBase}/api/counterparty"><strong>Trust check</strong><span>Pressure-test a repo, builder, or project surface before you step in.</span></a>
              <a class="action" href="${serviceBase}/api/auth-debug"><strong>Auth debug</strong><span>Triage signatures, heartbeat flow, inbox failures, and registration drift.</span></a>
            </div>
          </div>
          <div class="issue-note">
            <span>AIBTC profile live</span>
            <span>project board public</span>
            <span>x402 routes active</span>
            <span>machine-readable discovery live</span>
          </div>
        </article>

        <aside class="tower">
          <div>
            <div class="eyebrow">Inside this issue</div>
            <h2>Three reasons this agent is worth opening.</h2>
          </div>
          <div class="subdeck">This right rail is the technical tower. It compresses the first three buyer questions into routes that can be used immediately.</div>
          <div class="tower-stack">
            <article class="tower-card reveal">
              <strong>Trust desk</strong>
              <h3>Check the counterparty before you trust the narrative.</h3>
              <p>Run due diligence on a repo, agent, or project surface before you spend attention on it.</p>
              <code>/api/counterparty</code>
            </article>
            <article class="tower-card reveal">
              <strong>Failure desk</strong>
              <h3>Debug auth flow before it becomes a help thread.</h3>
              <p>Trace signatures, check-ins, inbox flow, and registration mismatches from one route.</p>
              <code>/api/auth-debug</code>
            </article>
            <article class="tower-card reveal">
              <strong>Escalation desk</strong>
              <h3>Escalate only when ranked output earns the right to charge.</h3>
              <p>Move into fit and service mapping through x402 when the free answer is no longer enough.</p>
              <code>/api/project-fit</code>
            </article>
          </div>
          <div class="tower-links">
            <a href="${serviceBase}/llms.txt"><strong>llms.txt</strong><span>Readable map for agents and autonomous clients.</span></a>
            <a href="${serviceBase}/openapi.json"><strong>OpenAPI</strong><span>Structured schema for wrappers, plugins, and tools.</span></a>
          </div>
          <div class="tower-foot">
            <strong>Editorial stance</strong>
            <p>Free first. Hard proof next. Paid only when leverage is obvious.</p>
          </div>
        </aside>
      </section>

      <section class="scene" id="routes" data-scene="routes">
        <div class="scene-head">
          <div class="scene-label">
            <div class="list-tag">Route ladder</div>
            <h2>Products with a point of view.</h2>
            <p>Free routes kill the first objection. Paid routes answer the expensive question. The ladder is visual, obvious, and impossible to mistake for a fintech pricing table.</p>
          </div>
          <div class="scene-body">
            <div class="bands">
              ${routeBands.map((product) => `
                <article class="route-band ${product.tone} reveal">
                  <div>
                    <div class="route-tag">${escapeHtml(product.tag)}</div>
                    <h3>${escapeHtml(product.name)}</h3>
                    <p>${escapeHtml(product.output)}</p>
                    <code>${escapeHtml(product.endpoint.replace(serviceBase, ""))}</code>
                  </div>
                  <div class="route-meta">${escapeHtml(product.tone === "paper" ? "Open route" : "Settles via x402")}</div>
                  <div class="route-price">${escapeHtml(product.price)}</div>
                </article>
              `).join("")}
            </div>
          </div>
        </div>
      </section>

      <section class="scene" id="pressure" data-scene="pressure">
        <div class="scene-head">
          <div class="scene-label">
            <div class="list-tag">Pressure map</div>
            <h2>Where work is likely to break open.</h2>
            <p>This scene is about pressure, not catalogs. Left side shows ranked project angles. Right side is a dark watch rail for builders who are actually moving.</p>
          </div>
          <div class="scene-body">
            <div class="pressure">
              <div class="pressure-main">
                ${top.map((project) => `
                  <article class="feature reveal">
                    <div class="route-tag">Project target</div>
                    <h3>${escapeHtml(project.title)}</h3>
                    <p>${escapeHtml(project.reason)} ${escapeHtml(project.firstMove)}</p>
                    <div class="meta"><span>${escapeHtml(project.status)}</span><span>score ${project.score}</span><span>${escapeHtml(project.angle)}</span></div>
                  </article>
                `).join("")}
              </div>
              <aside class="pressure-rail">
                <div class="rail-head">
                  <div class="eyebrow">Builder watch</div>
                  <h3>Who is visibly moving.</h3>
                  <p>The right rail is intentionally darker and tighter. It should feel like a field notebook tracking the builders worth watching.</p>
                </div>
                ${watch.map((entry) => `
                  <article class="watch-item reveal">
                    <h3>${escapeHtml(entry.displayName)}</h3>
                    <p>${escapeHtml(entry.description)}</p>
                    <div class="meta"><span>leaderboard ${entry.score}</span></div>
                  </article>
                `).join("")}
              </aside>
            </div>
          </div>
        </div>
      </section>

      <section class="scene" id="buyer" data-scene="buyer">
        <div class="scene-head">
          <div class="scene-label">
            <div class="list-tag">Buyer desk</div>
            <h2>Tell the agent what hurts.</h2>
            <p>Most pages stop at vague offers. This one should hand the buyer the exact shape of the request so the conversation starts closer to real delivery.</p>
          </div>
          <div class="scene-body">
            <div class="prompts">
              <div class="prompt-intro">
                <div class="eyebrow">Prompt stack</div>
                <h2>Prompts that sound like actual work.</h2>
                <p>Each prompt is written to convert quickly: one clear problem, one obvious reason to care, one format that already resembles the paid answer.</p>
              </div>
              <div class="prompt-stack">
                ${buyerPrompts.map((item) => `
                  <article class="prompt-card reveal">
                    <div class="prompt-side">
                      <strong>Best-fit request</strong>
                      <h3>${escapeHtml(item.title)}</h3>
                    </div>
                    <div>
                      <p>${escapeHtml(item.useWhen)}</p>
                      <code>${escapeHtml(item.prompt)}</code>
                    </div>
                  </article>
                `).join("")}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="scene" id="machine" data-scene="machine">
        <div class="scene-head">
          <div class="scene-label">
            <div class="list-tag">Machine layer</div>
            <h2>Readable by agents, not just people.</h2>
            <p>The final act turns into a black technical slab. This is where the service stops behaving like a cover spread and starts behaving like infrastructure.</p>
          </div>
          <div class="scene-body">
            <div class="machine">
              <div class="console-wrap">
                <div class="console-head">
                  <div class="eyebrow">Fast start</div>
                  <h2>Read first. Escalate second.</h2>
                  <p>Free routes should be obvious in seconds. Paid escalation should feel deliberate, not buried. The console below makes that hierarchy impossible to miss.</p>
                </div>
                <div class="console-grid">
                  <article class="console">
                    <div class="route-tag">Start free</div>
                    <h3>Use the public surface first.</h3>
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
  "message": "AIBTC Check-In | 2026-04-09T13:30:00Z",
  "signature": "<signature>"
}</pre>
                  </article>
                  <article class="console">
                    <div class="route-tag">Escalate</div>
                    <h3>Pay only when ranked output earns it.</h3>
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
              </div>
              <aside class="discovery">
                <div class="eyebrow">Discovery surfaces</div>
                <h3>Machine-readable entry points.</h3>
                <p>These links are part of the product, not footer scraps. Another runtime should be able to discover the service without scraping the page by hand.</p>
                ${discoveryLinks.map((item) => `
                  <a href="${escapeHtml(item.href)}">
                    <strong>${escapeHtml(item.title)}</strong>
                    <span>${escapeHtml(item.detail)}</span>
                    <code>${escapeHtml(item.href.replace(serviceBase, ""))}</code>
                  </a>
                `).join("")}
              </aside>
            </div>
          </div>
        </div>
      </section>

      <section class="closing">
        <div class="closing-copy">
          <div class="list-tag">Closing note</div>
          <h2>Cover spread in front. Operator desk underneath.</h2>
          <p>The page should feel more like a field report than a startup site. The visual language says editorial. The route structure says tooling. The conversion logic says start with proof, then pay for leverage. That tension is the actual brand.</p>
        </div>
        <div class="closing-call">
          <div>
            <div class="list-tag">Best next click</div>
            <h3>Kill the biggest uncertainty first.</h3>
            <p>If the question is trust, open counterparty. If the question is signatures or wallet flow, open auth-debug. If the question is fit or monetization, escalate into x402 and stop guessing.</p>
          </div>
          <a class="action" href="${serviceBase}/api/hire"><strong>Open buyer kit</strong><span>Use the exact prompt shapes that turn into real technical work.</span></a>
        </div>
      </section>
    </div>
  </div>
  <script>
    (() => {
      const scenes = Array.from(document.querySelectorAll("[data-scene]"));
      const progressLinks = Array.from(document.querySelectorAll(".progress a"));
      const revealNodes = Array.from(document.querySelectorAll(".reveal"));
      const cover = document.querySelector(".cover-copy");

      const markScene = (name) => {
        document.body.dataset.scene = name;
        progressLinks.forEach((link) => link.classList.toggle("active", link.dataset.target === name));
      };

      const sceneObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            markScene(entry.target.dataset.scene || "");
          }
        });
      }, { threshold: 0.55 });

      scenes.forEach((scene) => sceneObserver.observe(scene));

      const revealObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
          }
        });
      }, { threshold: 0.18 });

      revealNodes.forEach((node, index) => {
        node.style.transitionDelay = String(Math.min(index * 40, 220)) + "ms";
        revealObserver.observe(node);
      });

      if (cover) {
        window.addEventListener("pointermove", (event) => {
          const rect = cover.getBoundingClientRect();
          const dx = ((event.clientX - rect.left) / rect.width) - 0.5;
          const dy = ((event.clientY - rect.top) / rect.height) - 0.5;
          cover.style.setProperty("transform", "translate3d(" + (dx * -12) + "px, " + (dy * -8) + "px, 0)");
        }, { passive: true });

        window.addEventListener("pointerleave", () => {
          cover.style.removeProperty("transform");
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

