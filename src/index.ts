import { Hono } from "hono";
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

const ACTIVITY_URL = "https://aibtc.com/api/activity";
const LEADERBOARD_URL = "https://aibtc.com/api/leaderboard?limit=10";
const PROJECTS_URL = "https://aibtc-projects.pages.dev/api/items";
const BOUNTY_STATS_URL = "https://bounty.drx4.xyz/api/stats";
const RELEVANCE_PATTERN = /(bitcoin|stacks|x402|agent|api|tool|skill|audit|review|dashboard|infra|oracle|sign|verify)/i;

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

function scoreProject(project: Project): number {
  const searchable = `${project.title} ${project.description}`;
  let score = 0;

  if (project.status === "todo" && !project.claimedBy) score += 60;
  if (project.status === "blocked") score += 55;
  if (project.status === "in-progress") score += 20;
  if (RELEVANCE_PATTERN.test(searchable)) score += 25;
  score += Math.min(15, project.openGoals * 4);
  score += Math.min(10, project.deliverableCount * 2);
  score += Math.min(10, project.mentions);
  score += Math.min(10, Math.round(project.reputationAverage * 2));
  if (project.reputationCount > 1) score += 5;

  return score;
}

function buildServiceGaps(projects: Project[]) {
  const searchable = projects.map((project) => `${project.title} ${project.description}`).join(" ").toLowerCase();
  const gaps: Array<{ title: string; reason: string; action: string }> = [];

  if (!/reputation/.test(searchable)) {
    gaps.push({
      title: "Reputation report API",
      reason: "Public projects show work boards, dashboards, and infra, but not a dedicated paid reputation report for counterparties.",
      action: "Ship a wallet-to-wallet due-diligence endpoint for agent trust checks.",
    });
  }

  if (!/signature|verification|bip-137/.test(searchable)) {
    gaps.push({
      title: "Signature verification utility",
      reason: "Agent coordination depends on message signing, but a dedicated verification/debugging utility is not obvious on the public board.",
      action: "Offer a small paid endpoint for signature validation and settlement debugging.",
    });
  }

  if (!/opportunity board|opportunity|digest|market intelligence/.test(searchable)) {
    gaps.push({
      title: "Opportunity intelligence digest",
      reason: "Open work is fragmented across projects, leaderboard shifts, and ecosystem stats.",
      action: "Expose a ranked digest that turns public AIBTC data into monetizable opportunity intelligence.",
    });
  }

  return gaps;
}

app.get("/", (c) => {
  return c.json({
    service: "satsmith-opportunity-digest",
    version: "0.1.0",
    description: "Paid x402 digest for ranked AIBTC opportunities, builder watchlists, and service gaps.",
    endpoints: {
      "/health": { method: "GET", cost: "free" },
      "/api/digest": {
        method: "POST",
        cost: "100 sats (sBTC)",
        body: {
          limit: "number, optional, defaults to 5",
          filter: "string, optional keyword filter",
        },
      },
    },
    recipient: c.env.RECIPIENT_ADDRESS ? "configured" : "missing",
  });
});

app.get("/health", async (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    network: c.env.NETWORK || "mainnet",
  });
});

app.post(
  "/api/digest",
  x402Middleware({
    amount: "100",
    tokenType: "sBTC",
  }),
  async (c) => {
    const body: { limit?: number; filter?: string } = await c.req
      .json<{ limit?: number; filter?: string }>()
      .catch(() => ({}));
    const limit = Math.max(1, Math.min(10, toNumber(body.limit, 5)));
    const filter = String(body.filter ?? "").trim().toLowerCase();

    const [activityPayload, leaderboardPayload, projectsPayload, bountyPayload] = await Promise.all([
      fetchJson<{ stats?: { totalAgents?: number; activeAgents?: number; totalMessages?: number; totalSatsTransacted?: number } }>(ACTIVITY_URL),
      fetchJson<{ leaderboard?: Array<{ displayName?: string; description?: string; score?: number }> }>(LEADERBOARD_URL),
      fetchJson<{ items?: unknown[] }>(PROJECTS_URL),
      fetchJson<{ stats?: { open_bounties?: number; total_paid_sats?: number } }>(BOUNTY_STATS_URL),
    ]);

    const activity = activityPayload.stats ?? {};
    const leaderboard = Array.isArray(leaderboardPayload.leaderboard) ? leaderboardPayload.leaderboard : [];
    const projects = normalizeProjects(projectsPayload);

    const rankedProjects = projects
      .map((project) => ({
        ...project,
        score: scoreProject(project),
      }))
      .filter((project) => {
        if (!filter) return true;
        return `${project.title} ${project.description} ${project.githubUrl ?? ""}`.toLowerCase().includes(filter);
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((project) => ({
        id: project.id,
        title: project.title,
        status: project.status,
        score: project.score,
        founder: project.founder,
        githubUrl: project.githubUrl,
        openGoals: project.openGoals,
        deliverables: project.deliverableCount,
        reason:
          project.status === "blocked"
            ? "Blocked technical project with high potential urgency."
            : project.status === "todo" && !project.claimedBy
              ? "Unclaimed project aligned with shipping work."
              : "Active technical project worth tracking.",
      }));

    const digest = {
      generatedAt: new Date().toISOString(),
      filter: filter || null,
      summary: {
        totalAgents: toNumber(activity.totalAgents),
        activeAgents: toNumber(activity.activeAgents),
        totalMessages: toNumber(activity.totalMessages),
        totalSatsTransacted: toNumber(activity.totalSatsTransacted),
        openBounties: toNumber(bountyPayload.stats?.open_bounties),
        publicBountyPayoutSats: toNumber(bountyPayload.stats?.total_paid_sats),
      },
      opportunities: rankedProjects,
      leaderboardWatch: leaderboard.slice(0, 3).map((entry) => ({
        displayName: entry.displayName ?? "Unknown",
        score: toNumber(entry.score),
        description: short(entry.description ?? "No public description"),
      })),
      serviceGaps: buildServiceGaps(projects),
      sources: [ACTIVITY_URL, LEADERBOARD_URL, PROJECTS_URL, BOUNTY_STATS_URL],
      payment: {
        payer: c.get("x402")?.payerAddress ?? "unknown",
        txId: c.get("x402")?.settleResult?.txId ?? null,
      },
    };

    return c.json(digest);
  },
);

export default app;
