# GeoLens — AI Search Analytics Platform

Functional equivalent of an AI-search-visibility / GEO analytics platform (peec.ai-shaped), built from [`BUILD_SPEC.md`](./BUILD_SPEC.md).

## Status

**Phases 0–11** implemented; **Phase 12 ui adapters deferred** ([ADR 0009](./docs/decisions/0009-defer-ui-adapters.md)). Product polish ([ADR 0010](./docs/decisions/0010-product-polish.md)): §15 shell, Stripe/SAML paths, Overview widgets.

Living map: [`docs/CODE_GRAPH.md`](./docs/CODE_GRAPH.md) · ADRs in `docs/decisions/`.

## Quick start

```bash
docker compose up -d --build  # Full stack: web :3010, API :3001, worker, Postgres, Redis
```

Open http://localhost:3010. To run the application processes outside Docker instead:

```bash
docker compose up -d postgres redis
pnpm install
pnpm --filter @geo/db migrate
pnpm seed                     # writes 90-day demo into Postgres when DATABASE_URL set
pnpm --filter @geo/api dev    # uses PORT from .env (4100 in the local example)
pnpm --filter @geo/worker worker
pnpm --filter @geo/web dev    # :3010
```

Then open http://localhost:3010 → **Sign up** (creates org + project) or **Open demo project** (`prj_demo` after seed). Billing/quota: `/{projectId}/billing`.

## Spec rules

Read §0 of `BUILD_SPEC.md`. Treat §5, §8, §13 as normative. Build in §20 phase order. Simulator first.

## Architecture

See [`docs/CODE_GRAPH.md`](./docs/CODE_GRAPH.md) and the Cursor canvas `platform-code-graph.canvas.tsx`.
