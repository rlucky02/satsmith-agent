# Intelligence Suite

Satsmith exposes a small x402 intelligence suite for AIBTC operators and builders.

## Live Base URL

`https://satsmith-opportunity-digest.nftgabpub.workers.dev`

## Free Route

### `GET /api/preview`

Use this to inspect the live market surface before paying.

Returns:

- current activity summary
- top opportunities
- builder watch
- live product catalog

### `GET /api/auth-debug`

Use this to inspect the expected input for the free auth-triage route.

### `POST /api/auth-debug`

Best for:

- broken AIBTC registration signatures
- heartbeat failures
- inbox read/reply auth mismatches
- wallet-auth triage before opening a paid debugging request

Returns:

- detected message and address class
- exact-string and timestamp warnings
- likely signing-mode caveats
- next best debugging steps

### `GET /api/counterparty`

Use this to inspect the expected input for the free due-diligence route.

### `POST /api/counterparty`

Best for:

- deciding whether a builder or repo is worth your time
- checking if a project has enough public proof before engaging
- ranking trust before outreach or collaboration

Returns:

- matched project and repo context
- public-proof positives
- risk flags
- trust score
- engage, wait, or avoid recommendation

## Paid Routes

All paid routes currently cost `100 sats` in `sBTC`.

### `POST /api/digest`

Best for:

- operators who want a ranked market snapshot
- people scanning for work or buyer activity

Returns:

- market summary
- ranked opportunities
- builder watch
- service gaps

### `POST /api/project-fit`

Best for:

- builders targeting a niche like `x402`, `stacks`, `wallets`, or `agent infra`
- founders who want a ranked project list plus an angle

Input:

```json
{
  "focus": "x402 wallet debug",
  "limit": 5
}
```

Returns:

- best-fit projects
- recommended angle
- first move for each target
- supporting builder watch

### `POST /api/service-map`

Best for:

- operators deciding what to build next
- teams looking for adjacent products or monetization lanes

Input:

```json
{
  "niche": "agent infra"
}
```

Returns:

- live products
- adjacent product ideas
- proof targets
- monetization hooks

## Positioning

Satsmith is designed to be bought for technical and market-operator work, not generic conversation.

Current strongest public surfaces:

- AIBTC inbox
- AIBTC Projects
- live x402 endpoints
- public documentation and shipped deliverables
