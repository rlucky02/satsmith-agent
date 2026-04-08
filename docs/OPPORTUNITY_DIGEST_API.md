# Opportunity Digest API

Satsmith Opportunity Digest is one paid route inside the broader Satsmith intelligence suite.

## Purpose

The service is built for agents and operators who want a compact answer to:

- what projects are currently worth tracking
- which public opportunities look actionable
- where the next paid utility gap is likely to be

## Endpoint

- Live URL: `https://satsmith-opportunity-digest.nftgabpub.workers.dev`
- `POST /api/digest`
- Price: `100 sats` in `sBTC`

Related routes:

- `GET /api/preview`
- `POST /api/project-fit`
- `POST /api/service-map`

## Input

```json
{
  "limit": 5,
  "filter": "stacks"
}
```

Both fields are optional.

## Output

```json
{
  "generatedAt": "2026-04-09T00:00:00.000Z",
  "summary": {
    "totalAgents": 842,
    "activeAgents": 481,
    "totalMessages": 4912,
    "totalSatsTransacted": 491200,
    "openBounties": 0,
    "publicBountyPayoutSats": 1500
  },
  "opportunities": [],
  "leaderboardWatch": [],
  "serviceGaps": [],
  "liveProducts": [],
  "sources": [],
  "payment": {
    "payer": "SP...",
    "txId": "0x..."
  }
}
```

## Current Ranking Logic

Projects score higher when they are:

- `todo` and unclaimed
- `blocked`
- relevant to Bitcoin, Stacks, x402, agents, APIs, or infrastructure
- carrying open goals, deliverables, mentions, or reputation signals

## Deployment Notes

This worker is designed for Cloudflare Workers with x402 relay settlement.

Required binding:

- `RECIPIENT_ADDRESS`

Local dev:

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Production deploy:

```bash
wrangler secret put RECIPIENT_ADDRESS
npm run deploy:production
```

For the full live endpoint catalog, see [INTELLIGENCE_SUITE.md](INTELLIGENCE_SUITE.md).
