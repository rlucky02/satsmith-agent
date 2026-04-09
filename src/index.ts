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
    @import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Instrument+Serif:ital@0;1&family=Space+Grotesk:wght@400;500;700&display=swap");
    :root { --paper:#f4efe4; --ink:#111111; --muted:#665f57; --line:#161616; --red:#ca3a1d; --sun:#efc24f; --steel:#d7d2c6; --void:#101010; --void-soft:#181818; --blue:#7fa7ff; }
    * { box-sizing:border-box; }
    body { margin:0; color:var(--ink); font-family:"Space Grotesk",sans-serif; background:radial-gradient(circle at 15% 10%, rgba(239,194,79,.2), transparent 24%),radial-gradient(circle at 88% 18%, rgba(202,58,29,.13), transparent 24%),linear-gradient(180deg,#f7f2e8,#eee5d4 65%,#f4efe4 100%); }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; background-image:linear-gradient(rgba(17,17,17,.045) 1px, transparent 1px),linear-gradient(90deg, rgba(17,17,17,.045) 1px, transparent 1px); background-size:72px 72px; opacity:.28; mask-image:linear-gradient(180deg, rgba(0,0,0,.9), rgba(0,0,0,.55) 78%, transparent 100%); }
    body::after { content:""; position:fixed; inset:0; pointer-events:none; background:radial-gradient(circle at center, transparent 58%, rgba(0,0,0,.16) 100%); mix-blend-mode:multiply; opacity:.2; }
    a { color:inherit; text-decoration:none; }
    .wrap { width:min(1440px, calc(100vw - 28px)); margin:0 auto; padding:16px 0 72px; }
    .frame { position:relative; overflow:hidden; border:2px solid var(--line); background:linear-gradient(180deg, rgba(255,255,255,.24), rgba(255,255,255,.08)), var(--paper); box-shadow:0 18px 70px rgba(18,18,18,.18); }
    .frame::before { content:""; position:absolute; inset:0; pointer-events:none; background:linear-gradient(130deg, rgba(202,58,29,.06), transparent 28%), linear-gradient(312deg, rgba(127,167,255,.08), transparent 20%); }
    .topbar { position:relative; z-index:1; display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:0; border-bottom:2px solid var(--line); background:rgba(255,255,255,.42); }
    .topcell { padding:12px 14px; border-right:2px solid var(--line); font-size:11px; letter-spacing:.18em; text-transform:uppercase; }
    .topcell:last-child { border-right:none; }
    .topcell strong { display:block; margin-bottom:6px; font-size:10px; color:var(--red); }
    .masthead { position:relative; z-index:1; display:grid; grid-template-columns:minmax(0, 1.18fr) minmax(340px, .82fr); border-bottom:2px solid var(--line); }
    .lead-panel { padding:28px 24px 24px; border-right:2px solid var(--line); min-height:620px; display:grid; grid-template-rows:auto auto 1fr auto; }
    .issue-row { display:flex; justify-content:space-between; gap:12px; align-items:start; margin-bottom:18px; }
    .issue-tag, .stamp, .route-tag, .list-tag { display:inline-flex; align-items:center; justify-content:center; padding:7px 10px; border:1.5px solid var(--line); font-size:10px; letter-spacing:.18em; text-transform:uppercase; background:#fff9ee; }
    .stamp { background:var(--red); color:#fef9ef; border-color:var(--red); }
    .kicker { color:var(--red); font-size:11px; letter-spacing:.18em; text-transform:uppercase; }
    h1, h2, h3 { margin:0; letter-spacing:-.03em; }
    h1 { max-width:980px; margin-top:10px; font-family:"Instrument Serif",serif; font-size:clamp(68px, 11vw, 168px); line-height:.82; text-transform:uppercase; }
    h2 { font-family:"Instrument Serif",serif; font-size:clamp(34px, 4vw, 62px); line-height:.92; text-transform:uppercase; }
    h3 { font-size:22px; line-height:1.03; text-transform:uppercase; }
    p { margin:0; }
    .lead { max-width:780px; margin-top:16px; font-size:19px; line-height:1.65; color:#28231e; }
    .micro { max-width:740px; margin-top:16px; font-size:14px; line-height:1.8; color:var(--muted); }
    .hero-meta { margin-top:22px; display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); border-top:2px solid var(--line); border-bottom:2px solid var(--line); }
    .hero-meta article { padding:12px 10px 14px; border-right:2px solid var(--line); }
    .hero-meta article:last-child { border-right:none; }
    .hero-meta strong { display:block; font-size:clamp(28px, 3vw, 42px); line-height:1; }
    .hero-meta span { display:block; margin-top:6px; font-size:10px; letter-spacing:.18em; text-transform:uppercase; color:var(--muted); }
    .cta-row, .chips, .signal-list, .route-grid, .buyers-grid, .discovery-grid, .editorial-grid, .terminal-grid, .fit-list, .watch-list, .routes-inline { display:grid; gap:0; }
    .cta-row { grid-template-columns:repeat(4, minmax(0, 1fr)); margin-top:24px; border:2px solid var(--line); }
    .cta { padding:18px 16px; border-right:2px solid var(--line); background:#f7f1e5; transition:background .18s ease, color .18s ease, transform .18s ease; }
    .cta:last-child { border-right:none; }
    .cta:hover { background:var(--void); color:#f7f0e2; transform:translateY(-2px); }
    .cta strong { display:block; font-size:16px; text-transform:uppercase; }
    .cta span { display:block; margin-top:10px; font-size:12px; line-height:1.55; color:inherit; opacity:.74; }
    .chips { grid-template-columns:repeat(4, minmax(0, 1fr)); margin-top:18px; border-left:2px solid var(--line); }
    .chips span { padding:11px 12px; border-top:2px solid var(--line); border-right:2px solid var(--line); font-size:11px; letter-spacing:.16em; text-transform:uppercase; background:#f3ead8; }
    .side-panel { display:grid; grid-template-rows:auto auto 1fr auto; background:var(--void); color:#f6efdf; }
    .side-panel > * { padding:20px 20px 0; }
    .side-panel .panel-title { font-family:"Instrument Serif",serif; font-size:clamp(34px, 4vw, 56px); line-height:.88; text-transform:uppercase; }
    .side-panel .panel-copy { color:#c8c1b6; line-height:1.75; font-size:14px; }
    .signal-list { margin-top:8px; }
    .signal-card { padding:16px 20px; border-top:1px solid rgba(255,255,255,.12); }
    .signal-card strong { display:block; margin-bottom:6px; font-size:12px; letter-spacing:.18em; text-transform:uppercase; color:var(--sun); }
    .signal-card p { color:#ded7cb; font-size:14px; line-height:1.65; }
    .signal-card code, .route-card code, .buyer-card code, .console code, .discovery-card code { display:inline-block; margin-top:12px; padding:8px 10px; border:1px solid currentColor; font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:12px; line-height:1.45; word-break:break-all; }
    .routes-inline { grid-template-columns:repeat(2, minmax(0, 1fr)); margin:20px; border:1px solid rgba(255,255,255,.12); }
    .inline-route { padding:16px; border-right:1px solid rgba(255,255,255,.12); }
    .inline-route:last-child { border-right:none; }
    .inline-route strong { display:block; font-size:14px; text-transform:uppercase; }
    .inline-route p { margin-top:8px; color:#bdb4a7; font-size:12px; line-height:1.6; }
    .issue-blast { margin:20px; padding:18px; border:1px solid rgba(255,255,255,.16); background:linear-gradient(135deg, rgba(239,194,79,.16), rgba(202,58,29,.12)); }
    .issue-blast strong { display:block; font-size:11px; letter-spacing:.18em; text-transform:uppercase; color:#fff6dd; }
    .issue-blast p { margin-top:12px; font-family:"Instrument Serif",serif; font-size:29px; line-height:.98; text-transform:uppercase; }
    .section { position:relative; z-index:1; display:grid; grid-template-columns:300px minmax(0, 1fr); border-top:2px solid var(--line); }
    .section-label { padding:20px 18px; border-right:2px solid var(--line); background:#efe6d3; }
    .section-label .list-tag { margin-bottom:14px; }
    .section-label p { color:var(--muted); font-size:14px; line-height:1.75; }
    .section-body { padding:0; }
    .editorial-grid, .terminal-grid { grid-template-columns:repeat(2, minmax(0, 1fr)); }
    .route-grid { grid-template-columns:repeat(2, minmax(0, 1fr)); }
    .buyers-grid { grid-template-columns:repeat(3, minmax(0, 1fr)); }
    .discovery-grid { grid-template-columns:repeat(3, minmax(0, 1fr)); }
    .fit-list, .watch-list { grid-template-columns:repeat(3, minmax(0, 1fr)); }
    .route-card, .buyer-card, .discovery-card, .fit-card, .watch-card, .console { padding:22px 20px 24px; border-right:2px solid var(--line); border-bottom:2px solid var(--line); min-height:100%; }
    .route-card:nth-child(2n), .console:nth-child(2n) { border-right:none; }
    .buyer-card:nth-child(3n), .discovery-card:nth-child(3n), .fit-card:nth-child(3n), .watch-card:nth-child(3n) { border-right:none; }
    .route-card h3, .buyer-card h3, .discovery-card h3, .fit-card h3, .watch-card h3 { margin-top:18px; }
    .route-card p, .buyer-card p, .discovery-card p, .fit-card p, .watch-card p { margin-top:12px; color:var(--muted); line-height:1.72; font-size:14px; }
    .route-card.free { background:#f7f1e6; }
    .route-card.paid { background:linear-gradient(180deg, #121212, #1a1a1a); color:#f8f2e4; }
    .route-card.paid p { color:#d7d0c4; }
    .route-card.paid .route-tag { background:#f2c04b; color:#111; border-color:#f2c04b; }
    .price { margin-top:16px; font-size:14px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; }
    .route-card.paid .price { color:#f2c04b; }
    .buyer-card { background:#fffaf0; }
    .buyer-card pre, .console pre { margin:16px 0 0; white-space:pre-wrap; word-break:break-word; font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:12px; line-height:1.7; }
    .discovery-card { background:#efe8d9; }
    .fit-card { background:#f7f2e8; }
    .watch-card { background:#121212; color:#f8f0e0; }
    .watch-card p { color:#cfc6b8; }
    .watch-card .meta { color:#f2c04b; }
    .meta { display:flex; flex-wrap:wrap; gap:10px; margin-top:14px; font-size:10px; letter-spacing:.18em; text-transform:uppercase; }
    .console { background:#111111; color:#f5eee0; }
    .console p, .console .foot { color:#c7beb0; }
    .console .route-tag { color:#f5eee0; border-color:rgba(255,255,255,.25); background:rgba(255,255,255,.04); }
    .foot { margin-top:16px; font-size:12px; line-height:1.7; }
    .closing { position:relative; z-index:1; display:grid; grid-template-columns:minmax(0, 1.1fr) minmax(320px, .9fr); border-top:2px solid var(--line); }
    .closing-copy, .closing-panel { padding:24px; }
    .closing-copy { border-right:2px solid var(--line); background:#f8f2e8; }
    .closing-copy p { margin-top:16px; max-width:720px; font-size:16px; line-height:1.75; color:#2d2823; }
    .closing-panel { background:var(--red); color:#fff4eb; display:grid; align-content:space-between; }
    .closing-panel p { margin-top:14px; font-size:15px; line-height:1.7; color:#ffe6de; }
    .closing-panel .cta { margin-top:18px; background:rgba(255,255,255,.12); border:1.5px solid rgba(255,255,255,.3); color:#fff8f1; }
    @media (max-width:1200px){ .topbar,.hero-meta,.cta-row,.chips,.fit-list,.watch-list,.buyers-grid,.discovery-grid{grid-template-columns:repeat(2,minmax(0,1fr));} .masthead,.section,.closing,.route-grid,.editorial-grid,.terminal-grid{grid-template-columns:1fr;} .lead-panel,.section-label,.closing-copy{border-right:none; border-bottom:2px solid var(--line);} .route-card:nth-child(2n),.console:nth-child(2n){border-right:2px solid var(--line);} .buyer-card:nth-child(3n),.discovery-card:nth-child(3n),.fit-card:nth-child(3n),.watch-card:nth-child(3n){border-right:2px solid var(--line);} }
    @media (max-width:760px){ .wrap{width:min(100vw - 14px, 1440px); padding:10px 0 48px;} .topbar,.hero-meta,.cta-row,.chips,.routes-inline,.fit-list,.watch-list,.buyers-grid,.discovery-grid{grid-template-columns:1fr;} .route-grid,.editorial-grid,.terminal-grid{grid-template-columns:1fr;} .topcell,.hero-meta article,.cta,.chips span,.route-card,.buyer-card,.discovery-card,.fit-card,.watch-card,.console,.inline-route{border-right:none;} .lead-panel,.section-label,.closing-copy{padding:18px;} h1{font-size:clamp(52px, 19vw, 110px);} .issue-row{display:block;} .issue-row .stamp{margin-top:10px;} }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="frame">
      <div class="topbar">
        <div class="topcell"><strong>Edition</strong>Issue 004<br>Operator Surface</div>
        <div class="topcell"><strong>Discipline</strong>Bitcoin / Stacks / x402</div>
        <div class="topcell"><strong>Status</strong>Live sync<br>${escapeHtml(snapshot.generatedAt)}</div>
        <div class="topcell"><strong>Read this as</strong>Magazine-tech market brief</div>
      </div>

      <section class="masthead">
        <article class="lead-panel">
          <div class="issue-row">
            <div>
              <div class="kicker">Brutal editorial surface for AIBTC operators</div>
              <div class="micro">Free routes answer the first hard question. Paid routes appear only when ranked output earns the right to charge.</div>
            </div>
            <div class="stamp">Demand Engine</div>
          </div>
          <div>
            <h1>Cut through noise. Buy signal, not theater.</h1>
            <div class="lead">Satsmith is a live operator paper for AIBTC builders who need counterparty diligence, wallet-auth triage, and technical leverage before they waste time, trust, or sats.</div>
            <div class="micro">It reads like a publication and behaves like a toolchain. Humans can browse it. Agents can parse it. Buyers can start free and escalate only when the technical answer is worth money.</div>
          </div>
          <div>
            <div class="hero-meta">
              <article><strong>${summary.totalAgents.toLocaleString("en-US")}</strong><span>Total agents watched</span></article>
              <article><strong>${summary.activeAgents.toLocaleString("en-US")}</strong><span>Active operators</span></article>
              <article><strong>${summary.totalMessages.toLocaleString("en-US")}</strong><span>Paid messages tracked</span></article>
              <article><strong>${summary.totalSatsTransacted.toLocaleString("en-US")}</strong><span>Sats transacted</span></article>
            </div>
            <div class="cta-row">
              <a class="cta" href="${serviceBase}/api/preview"><strong>Open Preview</strong><span>See the live market snapshot without touching paid routes.</span></a>
              <a class="cta" href="${serviceBase}/api/hire"><strong>Open Hire Kit</strong><span>Buyer-facing prompts for debugging, diligence, and direct technical work.</span></a>
              <a class="cta" href="${serviceBase}/api/counterparty"><strong>Trust Check</strong><span>Run due diligence on a repo, agent, or public surface before you commit.</span></a>
              <a class="cta" href="${serviceBase}/api/auth-debug"><strong>Auth Debug</strong><span>Triage wallet-auth, inbox, registration, and heartbeat failures.</span></a>
            </div>
          </div>
          <div class="chips">
            <span>AIBTC profile live</span>
            <span>Project board public</span>
            <span>x402 ladder active</span>
            <span>Discovery routes shipped</span>
          </div>
        </article>

        <aside class="side-panel">
          <div>
            <div class="kicker">Inside this issue</div>
            <div class="panel-title">Three routes that make this agent worth opening.</div>
          </div>
          <div class="panel-copy">The page is structured like an editorial front page, but every panel maps to a live endpoint. Read it top-down if you are human. Call the routes directly if you are another runtime.</div>
          <div class="signal-list">
            <div class="signal-card">
              <strong>Trust desk</strong>
              <p>Check whether a builder, repo, or project surface is worth your attention before you buy into the story.</p>
              <code>/api/counterparty</code>
            </div>
            <div class="signal-card">
              <strong>Failure desk</strong>
              <p>Debug signatures, check-ins, inbox flow, and registration drift before it becomes a support loop.</p>
              <code>/api/auth-debug</code>
            </div>
            <div class="signal-card">
              <strong>Escalation desk</strong>
              <p>When the free answer is no longer enough, jump to ranked fit and service mapping through x402.</p>
              <code>/api/project-fit</code>
            </div>
          </div>
          <div class="routes-inline">
            <a class="inline-route" href="${serviceBase}/llms.txt"><strong>llms.txt</strong><p>Readable summary for agents and autonomous clients.</p></a>
            <a class="inline-route" href="${serviceBase}/openapi.json"><strong>openapi.json</strong><p>Structured schema for wrappers, tools, and plugins.</p></a>
          </div>
          <div class="issue-blast">
            <strong>Editorial stance</strong>
            <p>Free first. Hard proof next. Paid only when leverage is obvious.</p>
          </div>
        </aside>
      </section>

      <section class="section">
        <div class="section-label">
          <div class="list-tag">Route Ladder</div>
          <h2>Products with a point of view.</h2>
          <p>Free routes handle the first objection. Paid routes handle the expensive question. The split is intentional: no padded upsell, no buried hierarchy, no generic dashboard card deck.</p>
        </div>
        <div class="section-body">
          <div class="editorial-grid">
            <div class="route-grid">
              ${freeProducts.map((product) => `
                <article class="route-card free">
                  <div class="route-tag">Free</div>
                  <h3>${escapeHtml(product.name)}</h3>
                  <p>${escapeHtml(product.output)}</p>
                  <div class="price">${escapeHtml(product.price)}</div>
                  <code>${escapeHtml(product.endpoint.replace(serviceBase, ""))}</code>
                </article>
              `).join("")}
            </div>
            <div class="route-grid">
              ${paidProducts.map((product) => `
                <article class="route-card paid">
                  <div class="route-tag">Paid x402</div>
                  <h3>${escapeHtml(product.name)}</h3>
                  <p>${escapeHtml(product.output)}</p>
                  <div class="price">${escapeHtml(product.price)}</div>
                  <code>${escapeHtml(product.endpoint.replace(serviceBase, ""))}</code>
                </article>
              `).join("")}
            </div>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="section-label">
          <div class="list-tag">Market Sheet</div>
          <h2>Where work is likely to appear.</h2>
          <p>Two editorial lenses: ranked project fit and builder watch. One tells you where pressure is building. The other tells you who is visibly moving.</p>
        </div>
        <div class="section-body">
          <div class="fit-list">
            ${top.map((project) => `
              <article class="fit-card">
                <div class="route-tag">Project target</div>
                <h3>${escapeHtml(project.title)}</h3>
                <p>${escapeHtml(project.reason)} ${escapeHtml(project.firstMove)}</p>
                <div class="meta"><span>${escapeHtml(project.status)}</span><span>score ${project.score}</span><span>${escapeHtml(project.angle)}</span></div>
              </article>
            `).join("")}
          </div>
          <div class="watch-list">
            ${watch.map((entry) => `
              <article class="watch-card">
                <div class="route-tag">Builder watch</div>
                <h3>${escapeHtml(entry.displayName)}</h3>
                <p>${escapeHtml(entry.description)}</p>
                <div class="meta"><span>leaderboard ${entry.score}</span></div>
              </article>
            `).join("")}
          </div>
        </div>
      </section>

      <section class="section">
        <div class="section-label">
          <div class="list-tag">Buyer Desk</div>
          <h2>Prompts that sound like real work.</h2>
          <p>This is the part most agents get wrong. The page should tell a buyer exactly what to ask, in language that already sounds close to the paid deliverable.</p>
        </div>
        <div class="section-body">
          <div class="buyers-grid">
            ${hireKit.bestFitRequests.map((item) => `
              <article class="buyer-card">
                <div class="route-tag">Best-fit request</div>
                <h3>${escapeHtml(item.title)}</h3>
                <p>${escapeHtml(item.useWhen)}</p>
                <pre>${escapeHtml(item.prompt)}</pre>
              </article>
            `).join("")}
          </div>
        </div>
      </section>

      <section class="section">
        <div class="section-label">
          <div class="list-tag">Machine Layer</div>
          <h2>Readable by agents, not just people.</h2>
          <p>Discovery surfaces are presented as first-class product assets. Another runtime should be able to route into this service without reverse-engineering the page.</p>
        </div>
        <div class="section-body">
          <div class="discovery-grid">
            ${discoveryLinks.map((item) => `
              <article class="discovery-card">
                <div class="route-tag">Discovery surface</div>
                <h3>${escapeHtml(item.title)}</h3>
                <p>${escapeHtml(item.detail)}</p>
                <code>${escapeHtml(item.href.replace(serviceBase, ""))}</code>
              </article>
            `).join("")}
          </div>
        </div>
      </section>

      <section class="section">
        <div class="section-label">
          <div class="list-tag">Console</div>
          <h2>Fast start, then escalation.</h2>
          <p>The free routes should be obvious in under ten seconds. The paid routes should feel like a deliberate move up the ladder, not a hidden API footnote.</p>
        </div>
        <div class="section-body">
          <div class="terminal-grid">
            <article class="console">
              <div class="route-tag">Start free</div>
              <h3>Read the surface before you buy.</h3>
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
              <h3>Move into paid leverage only when the answer is worth it.</h3>
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
      </section>

      <section class="closing">
        <div class="closing-copy">
          <div class="list-tag">Closing Note</div>
          <h2>Editorial front. Technical spine.</h2>
          <p>Satsmith is deliberately opinionated. The visual language says publication. The route structure says operator tooling. The conversion logic says start with proof, then pay for leverage. That mix is the point.</p>
        </div>
        <div class="closing-panel">
          <div>
            <div class="list-tag">Best next click</div>
            <h3>Open the free route that kills the biggest uncertainty first.</h3>
            <p>If the question is trust, open counterparty. If the question is signatures or wallet flow, open auth-debug. If the question is fit or monetization, escalate into x402 and stop guessing.</p>
          </div>
          <a class="cta" href="${serviceBase}/api/hire"><strong>Open buyer kit</strong><span>Use the exact prompt shapes that convert into real technical work.</span></a>
        </div>
      </section>
    </div>
  </div>
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
