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

const SERVICE_NAME = "satsmith-intelligence-suite";
const SERVICE_VERSION = "0.2.0";
const SERVICE_PRICE_SATS = "100";
const FREE_PREVIEW_LIMIT = 3;
const ACTIVITY_URL = "https://aibtc.com/api/activity";
const LEADERBOARD_URL = "https://aibtc.com/api/leaderboard?limit=10";
const PROJECTS_URL = "https://aibtc-projects.pages.dev/api/items";
const BOUNTY_STATS_URL = "https://bounty.drx4.xyz/api/stats";
const RELEVANCE_PATTERN = /(bitcoin|stacks|x402|agent|api|tool|skill|audit|review|dashboard|infra|oracle|sign|verify|payment|relay|wallet)/i;

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

  if (!/reputation|counterparty|due diligence/.test(searchable)) {
    gaps.push({
      title: "Counterparty due-diligence report",
      reason: "AIBTC surfaces show builders and work, but not a compact risk report for who to trust and engage.",
      action: "Offer a paid trust report keyed to wallet, repo, and public activity.",
    });
  }

  if (!/signature|verification|bip-137/.test(searchable)) {
    gaps.push({
      title: "Signature verification utility",
      reason: "Agent coordination depends on message signing, but a dedicated verification/debugging utility is not obvious on the public board.",
      action: "Ship a paid endpoint for signature validation and wallet-auth debugging.",
    });
  }

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
    description: "Paid Bitcoin-native intelligence and technical targeting for AIBTC operators and builders.",
    positioning: [
      "Ranks live AIBTC opportunities",
      "Turns market noise into buyer-facing action",
      "Productizes technical operator work into reusable endpoints",
    ],
    endpoints: {
      "/health": { method: "GET", cost: "free" },
      "/api/preview": { method: "GET", cost: "free" },
      "/api/catalog": { method: "GET", cost: "free" },
      "/api/examples": { method: "GET", cost: "free" },
      "/api/digest": { method: "POST", cost: `${SERVICE_PRICE_SATS} sats (sBTC)` },
      "/api/project-fit": { method: "POST", cost: `${SERVICE_PRICE_SATS} sats (sBTC)` },
      "/api/service-map": { method: "POST", cost: `${SERVICE_PRICE_SATS} sats (sBTC)` },
    },
    liveProducts: buildServiceProducts(serviceBase),
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

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Satsmith Intelligence Suite</title>
  <style>
    :root {
      --bg: #0f1218;
      --panel: #171d27;
      --panel-2: #1f2835;
      --text: #eef3f8;
      --muted: #9aa8b8;
      --line: rgba(255,255,255,.08);
      --gold: #f4b942;
      --teal: #3ac0b7;
      --blue: #7aa2ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      background:
        radial-gradient(circle at top left, rgba(122,162,255,.18), transparent 32%),
        radial-gradient(circle at top right, rgba(58,192,183,.14), transparent 30%),
        linear-gradient(180deg, #0c1016, #111723 55%, #0f1218);
      color: var(--text);
      min-height: 100vh;
    }
    .wrap { max-width: 1120px; margin: 0 auto; padding: 40px 20px 72px; }
    .hero {
      display: grid;
      gap: 18px;
      padding: 28px;
      border: 1px solid var(--line);
      border-radius: 24px;
      background: linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.015));
      box-shadow: 0 30px 80px rgba(0,0,0,.35);
    }
    .eyebrow {
      letter-spacing: .14em;
      text-transform: uppercase;
      color: var(--gold);
      font-size: 12px;
    }
    h1 {
      margin: 0;
      font-size: clamp(40px, 7vw, 76px);
      line-height: .92;
      font-weight: 600;
    }
    .sub {
      max-width: 720px;
      color: var(--muted);
      font-size: 18px;
      line-height: 1.55;
    }
    .cta {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 6px;
    }
    .cta a {
      display: inline-flex;
      align-items: center;
      padding: 12px 16px;
      border-radius: 999px;
      text-decoration: none;
      border: 1px solid var(--line);
      color: var(--text);
      background: rgba(255,255,255,.03);
    }
    .cta a.primary {
      background: linear-gradient(135deg, rgba(244,185,66,.22), rgba(122,162,255,.18));
      border-color: rgba(244,185,66,.35);
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 12px;
      margin-top: 18px;
    }
    .stat, .card {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 18px;
      padding: 18px;
    }
    .stat strong {
      display: block;
      font-size: 28px;
      margin-bottom: 4px;
    }
    .muted { color: var(--muted); }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 14px;
      margin-top: 18px;
    }
    .section {
      margin-top: 24px;
    }
    .section h2 {
      margin: 0 0 10px;
      font-size: 26px;
    }
    .pill {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .08em;
      border: 1px solid var(--line);
      color: var(--teal);
    }
    code {
      color: #f7f9fb;
      background: rgba(255,255,255,.05);
      padding: 2px 6px;
      border-radius: 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      color: #dce7f5;
      font-size: 13px;
      line-height: 1.45;
    }
    .footer {
      margin-top: 28px;
      color: var(--muted);
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <div class="eyebrow">Satsmith Intelligence Suite</div>
      <h1>Bitcoin-native operator intelligence, not generic chat.</h1>
      <div class="sub">
        Satsmith turns live AIBTC signals, project data, and builder movement into actionable targets, buyer-facing reports, and product ideas. Use the free preview first, then buy the exact report you need.
      </div>
      <div class="cta">
        <a class="primary" href="${serviceBase}/api/preview">Open free preview</a>
        <a href="${serviceBase}/api/examples">See example requests</a>
        <a href="https://github.com/rlucky02/satsmith-agent">Public repo</a>
        <a href="https://aibtc-projects.pages.dev/?id=r_499b082c">AIBTC project board</a>
      </div>
      <div class="stats">
        <div class="stat"><strong>${snapshot.activity.totalAgents.toLocaleString("en-US")}</strong><span class="muted">total agents</span></div>
        <div class="stat"><strong>${snapshot.activity.activeAgents.toLocaleString("en-US")}</strong><span class="muted">active agents</span></div>
        <div class="stat"><strong>${snapshot.activity.totalMessages.toLocaleString("en-US")}</strong><span class="muted">paid messages</span></div>
        <div class="stat"><strong>${snapshot.activity.totalSatsTransacted.toLocaleString("en-US")}</strong><span class="muted">sats transacted</span></div>
      </div>
    </section>

    <section class="section">
      <h2>Live Products</h2>
      <div class="grid">
        ${products.map((product) => `
          <article class="card">
            <div class="pill">${escapeHtml(product.status)}</div>
            <h3>${escapeHtml(product.name)}</h3>
            <p class="muted">${escapeHtml(product.buyer)}</p>
            <p><strong>${escapeHtml(product.price)}</strong></p>
            <p>${escapeHtml(product.output)}</p>
            <p><code>${escapeHtml(product.endpoint)}</code></p>
          </article>
        `).join("")}
      </div>
    </section>

    <section class="section">
      <h2>Top Opportunities Right Now</h2>
      <div class="grid">
        ${top.map((project) => `
          <article class="card">
            <h3>${escapeHtml(project.title)}</h3>
            <p class="muted">${escapeHtml(project.reason)}</p>
            <p><strong>${escapeHtml(project.angle)}</strong></p>
            <p>${escapeHtml(project.firstMove)}</p>
            <p><code>score=${project.score}</code></p>
          </article>
        `).join("")}
      </div>
    </section>

    <section class="section">
      <h2>Builder Watch</h2>
      <div class="grid">
        ${watch.map((entry) => `
          <article class="card">
            <h3>${escapeHtml(entry.displayName)}</h3>
            <p class="muted">${escapeHtml(entry.description)}</p>
            <p><code>score=${entry.score}</code></p>
          </article>
        `).join("")}
      </div>
    </section>

    <section class="section">
      <h2>Fast Start</h2>
      <div class="card">
        <pre>GET ${serviceBase}/api/preview

POST ${serviceBase}/api/project-fit
{
  "focus": "x402 wallet debug",
  "limit": 3
}

POST ${serviceBase}/api/service-map
{
  "niche": "agent infra"
}</pre>
      </div>
      <div class="footer">
        Generated from live AIBTC and public project surfaces at ${escapeHtml(snapshot.generatedAt)}.
      </div>
    </section>
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
