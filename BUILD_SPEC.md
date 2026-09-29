# Build Specification — "Peec-Equivalent" AI Search Analytics Platform

**Document version:** 1.0
**Target:** a complete, production-shaped clone of an AI-search-visibility / GEO analytics platform (functional equivalent of peec.ai)
**Audience:** an autonomous coding agent or engineering team implementing this from an empty repository

---

## 0. How to use this document

This is a build specification, not a summary. It is written so that an implementing model can work through it top to bottom without needing to consult the original product.

Rules for the implementer:

1. **Build in the phase order given in §20.** Each phase ends in a runnable, demonstrable state. Do not start Phase N+1 until Phase N's definition of done passes.
2. **Treat §5 (data model), §8 (metric engine), and §13 (API contract) as normative.** Exact column names, formulas, and response shapes matter — the frontend, API, MCP server and exports all depend on them. Deviating there causes cascading rework.
3. **Everything in §7 (extraction) and §9–§12 (subsystems) is algorithmic.** Pseudocode is given. Implement it as pure, unit-testable functions in `packages/core` with no I/O, so the algorithms can be tested against fixtures without a database.
4. **The collection layer (§6) must ship with a deterministic simulator adapter from day one.** The entire product must be fully runnable, seeded and demonstrable with zero third-party credentials. Real engine adapters are additive.
5. **Where this spec says MUST, it is a hard requirement. SHOULD is a strong default you may deviate from with a recorded reason in `docs/decisions/`.**
6. **Do not invent additional product surface.** The feature list in §1.2 is the scope. If you find yourself building a CRM, a content generator or a rank tracker, stop.

---

## 1. Product scope

### 1.1 What the product does, in one paragraph

People increasingly ask AI assistants ("what's the best CRM for a 20-person agency?") instead of searching keywords. The answer that assistant gives — which brands it names, in what order, how it describes them, and which web pages it drew on — is now a marketing channel with no analytics. This product creates that analytics layer. It runs a customer-defined set of natural-language prompts against many AI engines, every day, from many countries; parses every response into structured facts (brands mentioned and their order, sentiment, every URL retrieved and cited, background searches the model ran, ads, product carousels); aggregates those facts into four headline metrics plus source metrics; benchmarks the customer against competitors; and converts the gaps into a ranked list of concrete content and PR actions whose effect can then be measured.

### 1.2 Feature scope (the complete list)

| # | Subsystem | Summary | Spec |
|---|---|---|---|
| 1 | Projects & orgs | Multi-tenant orgs, projects per brand/client, RBAC, plans, credits | §16 |
| 2 | Brand profile | Auto-extracted from the customer's domain; seeds all generation | §7.11 |
| 3 | Prompt management | CRUD, topics, tags, system classification, bulk CSV, lifecycle states | §7.10, §15.4 |
| 4 | Prompt discovery | Guided generation wizard with distribution targets and coverage report | §15.5 |
| 5 | Prompt volume | 1–5 relative demand score per prompt | §7.12 |
| 6 | Competitor tracking | Auto-suggestion + manual, alias/regex matching, historical recompute | §7.1 |
| 7 | Collection | Engine adapters, scheduler, per-country execution, model channels | §6 |
| 8 | Extraction | Brand/position/sentiment/sources/citations/fanouts/features/ads/products | §7 |
| 9 | Metric engine | Visibility, SoV, Sentiment, Position, retrieval + citation metrics | §8 |
| 10 | Overview dashboard | Composable widget grid, saved views, sharing, PDF export | §15.2 |
| 11 | Brand Insights | Single-brand deep dive, performance matrix, rankings | §15.6 |
| 12 | Brand Perception | Market attributes, Objections, Fact-checking | §10 |
| 13 | Sources | Domains, URLs, classification + overrides, Gap Analysis, bookmarks | §15.7 |
| 14 | Fanouts | Background query analysis, grouping, common terms | §15.8 |
| 15 | Ads | Sponsored placements in AI answers, advertisers, spend tiers | §15.9 |
| 16 | Actions | Opportunity-scored recommendations, lifecycle, Impact measurement | §9 |
| 17 | AI Shopping | Catalog ingest, SKU-level visibility, win rate, attribute grid, merchants | §11 |
| 18 | Agent Analytics | Crawlability, Crawl Insights (server logs), AI Referrals (GA4) | §12 |
| 19 | Public API | REST, API keys, scoping, rate limits, OpenAPI | §13 |
| 20 | MCP server | Read + write tools, slash-command workflows, OAuth/PAT | §14 |
| 21 | Exports | CSV, Data-Studio-style connector endpoint, chat archive | §13.9 |

### 1.3 Explicit non-goals

- **Not a content generator.** The product recommends what to write and where to get placed; it never writes or publishes. This is a deliberate positioning choice — AI-generated content carries sourcing and uniqueness risk the analytics layer should not absorb.
- **Not a keyword rank tracker.** No SERP position tracking, no backlink index.
- **Not an LLM observability tool.** It measures brands inside answers, not model quality or developer traces.
- **Not a chatbot.** There is an in-app assistant (§15.13) but it only queries the product's own data.

### 1.4 The one thing that cannot be cloned cheaply, and what to do about it

The original product's real moat is not its dashboards — it is a fleet of browser-automation workers that drive the *actual web UIs* of ChatGPT, Gemini, Google AI Mode/Overviews, Perplexity and Copilot, logged out, from residential network egress in ~100 countries, at millions of runs per day. That exists because API responses differ materially from what a human sees: different retrieved sources, different citation counts, and the platform (not the caller) decides whether to run a live web search.

This spec therefore defines the collection layer as a **pluggable adapter interface** (§6.2) with three adapter classes:

- **`simulator`** — deterministic, seeded, no network. MUST be implemented first. Makes the whole product runnable and testable in CI with zero credentials.
- **`api`** — official provider APIs (OpenAI, Anthropic, Google, Perplexity Sonar, Mistral, DeepSeek, xAI). Legitimate, stable, cheap, but *not* representative of the human UI experience. Label data from these adapters as `surface_kind = 'api'` everywhere.
- **`ui`** — Playwright-driven browser automation against the consumer web UIs. Label `surface_kind = 'ui'`. **Read §21.1 before implementing.** This class carries genuine terms-of-service and legal exposure, and is the correct place for a build/buy decision.

**The product MUST be fully functional and honest with only `simulator` and `api` adapters.** Never present `api`-sourced data as if it were the human UI experience; the `surface_kind` flag must surface in the UI.

---

## 2. Domain glossary

Learn these seven concepts before writing code. Every part of the system is expressed in them.

**Chat** — the atomic unit of measurement: *one prompt × one engine × one country × one day → one AI response*. Every metric in the product is an aggregation over chats. If a number is ever wrong, the debugging path is always "open the chats behind it".

**Prompt** — a conversational question the customer wants to be found for. Not a keyword. Carries a location, exactly one topic, many tags, and a lifecycle state.

**Engine / model / model channel** — three distinct things, and conflating them is the most common design mistake:
- *engine/surface*: the user-facing product (ChatGPT UI, Google AI Mode, Perplexity API).
- *model*: the specific version that produced a response (`gpt-5-1`, `claude-sonnet-5`).
- *model channel*: a **stable identifier for a surface that survives model upgrades**, e.g. `openai-0` = "ChatGPT UI". Models churn constantly; if reporting filters on `model_id`, a customer's history fragments across IDs every time a vendor renames something. All reporting MUST default to `model_channel_id`. `model_id` is retained for provenance and deprecated for filtering.

**Source vs citation** — a *source* is any URL the model retrieved while composing the answer. A *citation* is a source explicitly referenced in the visible answer text. Every citation is a source; most sources are not citations. They are tracked separately because they need different optimization strategies: citations drive referral clicks, uncited sources still shape what the model believes.

**Brand visibility vs source visibility** — *brand visibility* = the brand is named in the answer. *Source visibility* = the brand's own domain was retrieved/cited, whether or not the brand was named. The two diagnose opposite problems: cited-but-never-named means weak name recognition; named-but-never-cited means the model associates you with a topic but doesn't trust your content as a reference.

**Fanout** — a background search query the model issues while composing an answer (a single tracked prompt commonly triggers 3–12). Fanouts reveal what the model is actually looking for, which is often quite different from the prompt as written.

**Gap** — a source (domain or URL) that appears frequently in the customer's tracked prompts, names one or more competitors, and does *not* name the customer. The primary raw material for the Actions engine.

---

## 3. System architecture

```
                        ┌──────────────────────────────────────────────┐
                        │  apps/web  (Next.js, dashboard + marketing)  │
                        └───────────────┬──────────────────────────────┘
                                        │ typed client (Eden/tRPC-style)
                        ┌───────────────▼──────────────────────────────┐
   API keys / OAuth ───►│  apps/api   (REST + OpenAPI + auth + RBAC)   │◄─── apps/mcp (MCP server)
                        └──┬──────────────────────┬────────────────┬───┘
                           │                      │                │
              ┌────────────▼─────┐   ┌────────────▼──────┐  ┌──────▼─────────┐
              │ Postgres         │   │ ClickHouse        │  │ Object storage │
              │ (source of truth)│   │ (chat facts +     │  │ (raw HTML,     │
              │ config, entities │   │  rollups, OLAP)   │  │  markdown,     │
              └────────▲─────────┘   └─────────▲─────────┘  │  screenshots)  │
                       │                       │            └──────▲─────────┘
                       │        writes         │                   │
              ┌────────┴───────────────────────┴───────────────────┴─────────┐
              │  apps/worker  (BullMQ consumers on Redis)                    │
              │  ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌────────────────┐  │
              │  │ scheduler│ │ collector │ │ enricher │ │ analyst        │  │
              │  │ (cron)   │ │ (adapters)│ │(extract) │ │(actions,       │  │
              │  │          │ │           │ │          │ │ perception,    │  │
              │  └──────────┘ └─────┬─────┘ └──────────┘ │ rollups)       │  │
              └─────────────────────┼──────────────────────────────────────┘
                                    │
                      ┌─────────────▼──────────────┐
                      │ adapters: simulator │ api  │ ui (Playwright + geo egress)
                      └────────────────────────────┘
```

### 3.1 The four pipelines

Everything in the product is one of four pipelines. Keep them separate; they have different failure modes, latencies and cost profiles.

| Pipeline | Trigger | Input | Output | Latency budget |
|---|---|---|---|---|
| **Collection** | Cron, daily per project | active prompts × active channels × countries | raw responses in object storage + `chat` rows | hours (spread over the day) |
| **Enrichment** | Per raw response | one raw response | brand mentions, sources, citations, fanouts, features, ads, products, claims | seconds |
| **Aggregation** | After enrichment; incremental | chat facts | daily rollups, materialized views | minutes |
| **Analysis** | Scheduled (weekly) + on demand | rollups + sources | actions, perception runs, prompt volume, competitor suggestions | minutes |

### 3.2 Why two databases

**Postgres** is the source of truth for everything a human edits: orgs, projects, prompts, brands, tags, topics, classifications overrides, actions, facts, catalog, integrations, API keys. Strongly consistent, relational, migration-managed.

**ClickHouse** stores the fact tables that grow without bound — `chat`, `chat_brand_mention`, `chat_source`, `chat_fanout`, `agent_log` — and serves every report query. This is not premature optimization; see the scale math:

> 3,000 customers × ~150 active prompts × 6 channels × 1 run/day ≈ **2.7M chats/day** ≈ 31/sec sustained. At ~8 sources per chat that is **~22M source rows/day**, ~8B/year. Reports must group-by 10 dimensions over 90-day windows interactively.

Postgres cannot serve that interactively; ClickHouse does it trivially with `SummingMergeTree` rollups.

**Single-node mode (REQUIRED for dev/self-host):** the repo MUST support `DATA_BACKEND=postgres`, where fact tables live in Postgres and reports run against the same SQL builder. A single project (350 prompts × 6 channels = 2,100 chats/day) is a rounding error for Postgres. `packages/core/src/metrics/query-builder.ts` MUST emit dialect-agnostic SQL with a thin dialect adapter, so both backends share one code path and one test suite.

### 3.3 Deployment shape

- `apps/web` — Vercel or any Node host. Static marketing pages + authenticated SPA-ish dashboard.
- `apps/api` — containerized, horizontally scalable, stateless. Behind a CDN for cacheable report GETs.
- `apps/worker` — containerized, scaled by queue depth. Three distinct worker pools with different resource profiles: `collector-api` (network-bound, high concurrency), `collector-ui` (memory-bound, one browser context per job, low concurrency, geo-pinned), `enricher`/`analyst` (CPU + LLM-call bound).
- Redis — BullMQ queues, rate-limit counters, short-lived caches.
- Object storage — raw HTML/JSON of every response (audit trail + reprocessing), scraped page markdown, generated PDFs.

**Reprocessing is a first-class requirement.** Raw responses MUST be retained so the enrichment pipeline can be re-run without re-collecting. Every extraction algorithm will have bugs; the ability to backfill a fix over 90 days of history is what makes those bugs survivable. Store `raw_uri` on every chat and implement `worker: reprocess --project X --from DATE --steps brands,sentiment`.

---

## 4. Tech stack and repository layout

### 4.1 Stack

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript everywhere, strict mode | one language across web/api/worker/mcp; shared domain types |
| Monorepo | pnpm workspaces + Turborepo | shared `packages/core` between api, worker, mcp |
| Web | Next.js (App Router), React | SSR marketing + rich authenticated dashboard |
| Styling | Tailwind CSS + shadcn/ui | do not hand-roll primitives (Button/Dialog/Table/Select) |
| Charts | Recharts (+ d3-scale for heatmaps/box plots) | line, bar, radar, box plot, heat map all required |
| Tables | TanStack Table | column visibility, reorder, sort, pin — all required by §15 |
| Data fetching | TanStack Query | caching + invalidation across a filter-heavy UI |
| API framework | Fastify (or ElysiaJS on Bun) + zod | schema-first, generates OpenAPI directly from zod |
| ORM / migrations | Drizzle ORM | typed SQL, real migration files, works for PG and CH reads |
| OLAP | ClickHouse (`@clickhouse/client`) | fact tables + rollups |
| Queues | BullMQ on Redis | retries, backoff, repeatable cron jobs, priorities |
| Browser automation | Playwright | `ui` adapters |
| Auth | better-auth (or Clerk) + org/project RBAC | email+password, SSO/SAML for enterprise |
| LLM calls (internal) | Vercel AI SDK | sentiment, classification, attribute extraction, action briefs |
| Errors/telemetry | Sentry + OpenTelemetry | client + server |
| Product analytics | PostHog | feature adoption |
| Tests | Vitest (unit) + Playwright (e2e) | pure-core algorithms are unit-tested against fixtures |

### 4.2 Repository layout

```
.
├── apps
│   ├── web                  # Next.js dashboard + marketing
│   │   ├── src/app/(marketing)/...
│   │   ├── src/app/(app)/[projectId]/...      # dashboard routes, see §15.1
│   │   └── src/components/{ui,charts,tables,filters,widgets}
│   ├── api                  # Fastify REST + OpenAPI
│   │   └── src/routes/{reports,projects,prompts,brands,...}
│   ├── worker               # BullMQ consumers
│   │   └── src/jobs/{schedule,collect,enrich,rollup,actions,perception,shopping,agent}
│   └── mcp                  # MCP server (Streamable HTTP)
├── packages
│   ├── core                 # PURE domain logic. No I/O. 100% unit-tested.
│   │   └── src/{extraction,metrics,actions,perception,shopping,scoring,robots}
│   ├── db                   # Drizzle schema, migrations, ClickHouse DDL, seeds
│   ├── adapters             # engine adapters (simulator | api | ui)
│   ├── contracts            # zod schemas shared by api + web + mcp; OpenAPI source
│   └── registry             # static data: channels, bots, assistant domains, countries
├── docs
│   ├── decisions/           # ADRs
│   └── runbooks/
└── BUILD_SPEC.md            # this file
```

**`packages/core` is the heart of the product.** Every algorithm in §7–§11 lives there as a pure function. If an algorithm needs a database, it is in the wrong package — pass data in, return data out. This is what makes the extraction logic testable against a fixture corpus, which is what makes it correct.

---

## 5. Data model (NORMATIVE)

### 5.1 Conventions

- **IDs are prefixed ULIDs**: `<prefix>_<ulid>`. Prefixes: `org_`, `usr_`, `prj_`, `br_` (brand), `pr_` (prompt), `tpc_` (topic), `tag_`, `cht_` (chat), `src_` (source page), `act_` (action), `fct_` (fact), `clm_` (claim), `prd_` (product), `cat_` (category), `mch_` (merchant), `key_` (api key), `pat_`, `vw_` (view), `sug_` (suggestion), `run_` (perception run). Prefixes make IDs self-describing in logs, API responses and MCP conversations.
- All timestamps are `timestamptz` stored UTC. All *dates* (a chat's run date, rollup buckets) are plain `date` in the **project's timezone** — a project in Berlin must see "yesterday" as Berlin's yesterday.
- `snake_case` in the database and in API JSON. The API MAY additionally emit `camelCase` duplicates of a few legacy fields for compatibility; do not proliferate this.
- Soft delete only where history matters (`prompt.is_archived`, `project.status`); hard delete where the user expects erasure (deleted prompts cascade to chats).
- Every multi-tenant table carries `project_id` (or `organization_id` for org-scoped) as the **first column of every index**. Row-level isolation MUST be enforced in a single query-builder chokepoint, not per-route.

### 5.2 Postgres — identity, tenancy, billing

```sql
CREATE TABLE organization (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  domain         text,
  timezone       text NOT NULL DEFAULT 'UTC',
  plan_code      text NOT NULL,              -- see §16.3
  billing_period text NOT NULL DEFAULT 'monthly' CHECK (billing_period IN ('monthly','annual')),
  is_agency      boolean NOT NULL DEFAULT false,
  credits_total  integer,                    -- agency plans only; NULL for brand plans
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id            text PRIMARY KEY,
  email         citext NOT NULL UNIQUE,
  name          text,
  avatar_url    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Org-level membership. 'owner' is required for all write operations via API/MCP.
CREATE TABLE org_member (
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  user_id         text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('owner','admin','member','guest')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE project (
  id               text PRIMARY KEY,
  organization_id  text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name             text NOT NULL,
  domain           text,                     -- primary owned domain; classifies sources as OWN
  extra_domains    text[] NOT NULL DEFAULT '{}',
  default_country  char(2) NOT NULL DEFAULT 'US',
  language         text NOT NULL DEFAULT 'en',
  timezone         text NOT NULL DEFAULT 'UTC',
  status           text NOT NULL DEFAULT 'ONBOARDING'
                   CHECK (status IN ('ONBOARDING','TRIAL','TRIAL_ENDED','CUSTOMER','CUSTOMER_ENDED',
                                     'PITCH','PITCH_ENDED','PAUSED','API_PARTNER','DELETED')),
  frequency        text NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily','weekly')),
  allocated_prompts integer NOT NULL DEFAULT 0,   -- quota assigned to this project
  created_at       timestamptz NOT NULL DEFAULT now(),
  paused_at        timestamptz
);
CREATE INDEX ON project (organization_id, status);

-- Per-project membership for agencies giving clients scoped read access.
CREATE TABLE project_member (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('editor','viewer')),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE api_key (
  id              text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  project_id      text REFERENCES project(id) ON DELETE CASCADE,  -- NULL = company-scoped
  name            text NOT NULL,
  key_hash        text NOT NULL,             -- argon2id(secret); plaintext shown once
  key_prefix      text NOT NULL,             -- first 8 chars, for display + lookup
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON api_key (key_prefix);

CREATE TABLE personal_access_token (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  name       text NOT NULL,
  token_hash text NOT NULL,
  token_prefix text NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

### 5.3 Postgres — engines and channels

```sql
-- A concrete model version. Provenance only; DEPRECATED as a reporting filter.
CREATE TABLE model (
  id           text PRIMARY KEY,             -- e.g. 'chatgpt-ui', 'claude-sonnet-5', 'sonar'
  vendor       text NOT NULL,                -- 'openai','google','anthropic','perplexity','xai',...
  display_name text NOT NULL,
  surface_kind text NOT NULL CHECK (surface_kind IN ('ui','api','simulator')),
  retired_at   timestamptz
);

-- Stable surface identifier. THE canonical reporting dimension.
CREATE TABLE model_channel (
  id                  text PRIMARY KEY,      -- '<vendor>-<index>' e.g. 'openai-0'
  vendor              text NOT NULL,
  description         text NOT NULL,         -- 'ChatGPT UI' — human-readable, may change
  surface_kind        text NOT NULL CHECK (surface_kind IN ('ui','api','simulator')),
  current_model_id    text NOT NULL REFERENCES model(id),
  unsupported_country_codes char(2)[] NOT NULL DEFAULT '{}',
  supports_fanouts    boolean NOT NULL DEFAULT false,
  supports_ads        boolean NOT NULL DEFAULT false,
  supports_shopping   boolean NOT NULL DEFAULT false,
  is_addon            boolean NOT NULL DEFAULT false,  -- gated behind paid upgrade
  sort_order          integer NOT NULL DEFAULT 0
);

-- History of which model backed a channel, so old chats resolve correctly.
CREATE TABLE model_channel_version (
  channel_id text NOT NULL REFERENCES model_channel(id) ON DELETE CASCADE,
  model_id   text NOT NULL REFERENCES model(id),
  valid_from date NOT NULL,
  valid_to   date,
  PRIMARY KEY (channel_id, valid_from)
);

-- Which channels a project actually runs (drives credit cost and collection fan-out).
CREATE TABLE project_model_channel (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  channel_id text NOT NULL REFERENCES model_channel(id),
  is_active  boolean NOT NULL DEFAULT true,
  PRIMARY KEY (project_id, channel_id)
);
```

Seed content for `model_channel` is in **Appendix A (§22.1)**.

### 5.4 Postgres — brands

```sql
CREATE TABLE brand (
  id            text PRIMARY KEY,
  project_id    text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  display_name  text NOT NULL,               -- cosmetic only, NEVER used for matching
  tracked_name  text NOT NULL,               -- primary match term, case-INSENSITIVE
  aliases       text[] NOT NULL DEFAULT '{}', -- additional match terms, case-INSENSITIVE
  match_regex   text,                        -- advanced matching, case-SENSITIVE
  domains       text[] NOT NULL DEFAULT '{}', -- classifies sources as OWN / COMPETITOR
  color         text NOT NULL DEFAULT 'blue',
  is_own        boolean NOT NULL DEFAULT false,
  source        text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','suggestion','onboarding')),
  recompute_state text NOT NULL DEFAULT 'idle'
                  CHECK (recompute_state IN ('idle','queued','running')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON brand (project_id);
CREATE UNIQUE INDEX ON brand (project_id, lower(tracked_name));
-- Exactly one own brand per project:
CREATE UNIQUE INDEX ON brand (project_id) WHERE is_own;

CREATE TABLE brand_suggestion (
  id            text PRIMARY KEY,
  project_id    text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name          text NOT NULL,
  mention_count integer NOT NULL DEFAULT 0,
  source        text NOT NULL CHECK (source IN ('chat','competitor')),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','rejected')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, lower(name))
);
```

**Critical behaviour:** changing `tracked_name`, `aliases` or `match_regex` MUST enqueue a historical recompute over all of that project's chats (§7.1.4). While `recompute_state <> 'idle'`, further edits to those three fields MUST return **HTTP 409 Conflict**. This prevents a queue of conflicting recomputes producing non-deterministic history.

### 5.5 Postgres — prompts, topics, tags

```sql
CREATE TABLE topic (
  id         text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE tag (
  id         text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name       text NOT NULL,
  "group"    text,        -- user-defined group name, or 'branding'/'intentType' for system tags
  color      text NOT NULL DEFAULT 'gray',
  is_system  boolean NOT NULL DEFAULT false,
  UNIQUE (project_id, name)
);

CREATE TABLE prompt (
  id           text PRIMARY KEY,
  project_id   text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  text         text NOT NULL CHECK (length(text) <= 200),
  country_code char(2) NOT NULL,
  language     text,
  topic_id     text REFERENCES topic(id) ON DELETE SET NULL,
  is_archived  boolean NOT NULL DEFAULT false,
  -- system classification, assigned asynchronously; NULL = classification in flight
  branding     text CHECK (branding IN ('branded','non-branded')),
  intent_type  text CHECK (intent_type IN ('informational','commercial','transactional')),
  volume_score smallint CHECK (volume_score BETWEEN 1 AND 5),
  volume_computed_at timestamptz,
  persona      text,                        -- from Prompt Discovery
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON prompt (project_id, is_archived);
CREATE UNIQUE INDEX ON prompt (project_id, lower(text), country_code);

CREATE TABLE prompt_tag (
  prompt_id text NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
  tag_id    text NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  PRIMARY KEY (prompt_id, tag_id)
);

CREATE TABLE prompt_suggestion_generation (
  id         text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  status     text NOT NULL CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED')),
  request    jsonb NOT NULL,      -- the discovery wizard config (§15.5)
  error      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE prompt_suggestion (
  id            text PRIMARY KEY,
  project_id    text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  generation_id text REFERENCES prompt_suggestion_generation(id) ON DELETE CASCADE,
  text          text NOT NULL,
  country_code  char(2),
  language      text,
  topic_id      text REFERENCES topic(id),
  pending_topic_name text,      -- discovery suggestions can carry a not-yet-created topic
  branding      text, intent_type text, persona text,
  volume_score  smallint,
  kind          text NOT NULL CHECK (kind IN ('standard','discovery')),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','rejected')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE topic_suggestion (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','rejected'))
);
```

### 5.6 Postgres — brand profile

```sql
CREATE TABLE brand_profile (
  project_id      text PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  description     text NOT NULL,             -- "what you do"
  industry        text NOT NULL,             -- decides the Perception competitor set
  brand_identity  text,                      -- premium / challenger / enterprise ...
  target_audience text,
  products_services jsonb NOT NULL DEFAULT '[]',   -- [{name, description}]
  target_markets  jsonb NOT NULL DEFAULT '[]',     -- [{country, market_size}]
  audience_distribution jsonb NOT NULL DEFAULT '[]', -- [{segment, pct}] MUST sum to 100
  prompt_builder  jsonb NOT NULL DEFAULT '{}',     -- {markets:[{country,language}], personas:[]}
  industry_changes_used smallint NOT NULL DEFAULT 0, -- Perception rerun budget (§10.1)
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

`market_size` enum: `Neighborhood | City | State/Province | National | Continental Bloc | Global`.

### 5.7 Postgres — source pages and classification

```sql
-- One row per distinct URL ever seen as a source, shared across chats.
CREATE TABLE source_page (
  id             text PRIMARY KEY,
  url            text NOT NULL,
  url_normalized text NOT NULL,              -- see §7.4.1
  domain         text NOT NULL,
  subdomain      text,
  title          text,
  channel_title  text,                       -- YouTube channel / subreddit / author
  markdown_uri   text,                        -- object-storage key of scraped content
  content_hash   text,
  heuristic_url_classification    text,      -- see §7.6
  heuristic_domain_classification text,      -- see §7.5
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  fetched_at     timestamptz,
  fetch_status   integer,
  UNIQUE (url_normalized)
);
CREATE INDEX ON source_page (domain);

CREATE TABLE custom_classification (
  id         text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  scope      text NOT NULL CHECK (scope IN ('domain','url')),
  name       text NOT NULL,
  color      text NOT NULL DEFAULT 'gray',
  UNIQUE (project_id, scope, name)
);

-- Per-project override of the heuristic classification. NULL classification = cleared.
CREATE TABLE classification_override (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  scope      text NOT NULL CHECK (scope IN ('domain','url')),
  target     text NOT NULL,        -- domain string, or url_normalized
  builtin    text,                 -- built-in enum value
  custom_id  text REFERENCES custom_classification(id) ON DELETE CASCADE,
  set_by     text REFERENCES app_user(id),
  set_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, scope, target),
  CHECK (builtin IS NULL OR custom_id IS NULL)
);

CREATE TABLE bookmark (
  project_id  text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('domain','url')),
  entity_key  text NOT NULL,
  PRIMARY KEY (project_id, user_id, entity_type, entity_key)
);
```

**Built-in domain classifications:** `CORPORATE | EDITORIAL | INSTITUTIONAL | REFERENCE | UGC | COMPETITOR | OWN | RELATED | OTHER`.

**Built-in URL classifications:** `HOMEPAGE | CATEGORY_PAGE | PRODUCT_PAGE | LISTICLE | COMPARISON | PROFILE | ALTERNATIVE | DISCUSSION | HOW_TO_GUIDE | ARTICLE | OTHER`.

`OWN` and `COMPETITOR` are **derived at query time** from `brand.domains`, not stored — they change whenever a brand's domains change. Resolution order for a domain's effective classification:

1. project override (custom or built-in) → use it
2. domain matches own brand's `domains` → `OWN`
3. domain matches a tracked competitor's `domains` → `COMPETITOR`
4. otherwise → `heuristic_domain_classification`

### 5.8 ClickHouse — fact tables (NORMATIVE)

```sql
-- One row per chat. The atomic unit.
CREATE TABLE chat (
  project_id        LowCardinality(String),
  chat_id           String,
  prompt_id         String,
  model_id          LowCardinality(String),
  channel_id        LowCardinality(String),
  surface_kind      LowCardinality(String),        -- ui | api | simulator
  country_code      LowCardinality(FixedString(2)),
  run_date          Date,                          -- project-timezone date
  run_at            DateTime64(3, 'UTC'),
  status            LowCardinality(String),        -- ok | empty | error | blocked
  error_code        LowCardinality(String),
  response_text     String,                        -- full assistant answer
  response_tokens   UInt32,
  sentiment_raw     Nullable(Float32),             -- own-brand sentiment in [-1, +1], NULL if absent
  brand_count       UInt16,                        -- total distinct brands detected
  source_count      UInt16,
  citation_count    UInt16,
  fanout_count      UInt16,
  features          Array(LowCardinality(String)), -- SHOPPING|PRODUCT_COMPARISON|AD|MAP|WEB_SEARCH|IMAGE
  raw_uri           String,                        -- object storage key of the raw capture
  extractor_version UInt16                         -- enables targeted reprocessing
) ENGINE = ReplacingMergeTree(run_at)
PARTITION BY toYYYYMM(run_date)
ORDER BY (project_id, run_date, prompt_id, channel_id, country_code, chat_id);

-- One row per (chat, brand) detected.
CREATE TABLE chat_brand_mention (
  project_id     LowCardinality(String),
  chat_id        String,
  prompt_id      String,
  channel_id     LowCardinality(String),
  country_code   LowCardinality(FixedString(2)),
  run_date       Date,
  brand_id       String,          -- '' when the brand is detected but untracked
  brand_key      String,          -- normalized surface form, always populated
  is_tracked     UInt8,
  position       UInt16,          -- 1-based rank over ALL detected brands (§7.2)
  mention_count  UInt16,          -- occurrences within this one chat
  first_char_idx UInt32,
  sentiment_raw  Nullable(Float32)
) ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(run_date)
ORDER BY (project_id, run_date, brand_id, prompt_id, channel_id, chat_id);

-- One row per (chat, source URL).
CREATE TABLE chat_source (
  project_id       LowCardinality(String),
  chat_id          String,
  prompt_id        String,
  channel_id       LowCardinality(String),
  country_code     LowCardinality(FixedString(2)),
  run_date         Date,
  url_normalized   String,
  domain           LowCardinality(String),
  citation_count   UInt16,        -- 0 => retrieved but not cited
  citation_position Nullable(UInt16),
  retrieval_rank   UInt16,        -- order in the sources list
  mentioned_brand_ids Array(String),  -- tracked brands named ON the page (§7.4.3)
  mentioned_brand_count UInt16
) ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(run_date)
ORDER BY (project_id, run_date, domain, url_normalized, chat_id);

CREATE TABLE chat_fanout (
  project_id  LowCardinality(String),
  chat_id     String,
  prompt_id   String,
  channel_id  LowCardinality(String),
  run_date    Date,
  query_index UInt16,
  query_text  String,
  query_type  LowCardinality(String)   -- search | shopping | synthetic
) ENGINE = MergeTree
PARTITION BY toYYYYMM(run_date)
ORDER BY (project_id, run_date, prompt_id, chat_id, query_index);

CREATE TABLE chat_ad (
  project_id LowCardinality(String),
  chat_id String, prompt_id String, channel_id LowCardinality(String),
  country_code LowCardinality(FixedString(2)), run_date Date,
  advertiser_name String,
  advertiser_brand_id String,          -- '' if untracked
  ad_unit_type LowCardinality(String),
  ads_request_id String,
  target_url String,
  target_domain LowCardinality(String),
  creative_hash String,                -- dedupes "unique creatives"
  card_title String, card_body String, card_image_url String
) ENGINE = MergeTree PARTITION BY toYYYYMM(run_date)
ORDER BY (project_id, run_date, advertiser_name, chat_id);

CREATE TABLE chat_product (
  project_id LowCardinality(String),
  chat_id String, prompt_id String, channel_id LowCardinality(String),
  country_code LowCardinality(FixedString(2)), run_date Date,
  product_id String,                   -- '' if not matched to catalog
  raw_name String,
  global_brand_id String,
  merchant_name String,
  position UInt16,                     -- rank in the carousel; 1 => "win"
  mentioned_price Nullable(Decimal(12,2)),
  currency LowCardinality(String),
  rating Nullable(Float32),
  attributes_json String               -- LLM-extracted attribute map
) ENGINE = MergeTree PARTITION BY toYYYYMM(run_date)
ORDER BY (project_id, run_date, product_id, chat_id);

-- AI bot server-log hits (Crawl Insights, §12.2)
CREATE TABLE agent_log (
  project_id LowCardinality(String),
  ts DateTime64(3,'UTC'),
  bot_id LowCardinality(String),
  bot_vendor LowCardinality(String),
  bot_type LowCardinality(String),     -- training | search | user_query | other
  request_host LowCardinality(String),
  request_path String,
  request_folder LowCardinality(String),
  request_method LowCardinality(String),
  response_status UInt16,
  country_code LowCardinality(FixedString(2)),
  client_ip String,
  referer String,
  user_agent String
) ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (project_id, ts, bot_id, request_path)
TTL toDateTime(ts) + INTERVAL 13 MONTH;
```

### 5.9 ClickHouse — rollups

Reports MUST read rollups, not raw facts, for any window > 7 days. Rollups are `SummingMergeTree` so ratio metrics recombine from sums (§8.3).

```sql
CREATE TABLE brand_daily (
  project_id LowCardinality(String), run_date Date,
  brand_id String, prompt_id String, topic_id String,
  channel_id LowCardinality(String), country_code LowCardinality(FixedString(2)),
  mention_count      UInt64,   -- total mentions of this brand
  visibility_count   UInt64,   -- chats where brand appeared ≥1
  visibility_total   UInt64,   -- chats in scope (denominator)
  position_sum       UInt64, position_count UInt64,
  sentiment_sum      Float64, sentiment_count UInt64
) ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(run_date)
ORDER BY (project_id, run_date, brand_id, prompt_id, channel_id, country_code, topic_id);

CREATE TABLE domain_daily (
  project_id LowCardinality(String), run_date Date,
  domain LowCardinality(String), prompt_id String, topic_id String,
  channel_id LowCardinality(String), country_code LowCardinality(FixedString(2)),
  retrieval_count     UInt64,  -- distinct URL retrievals from this domain
  retrieved_chat_count UInt64, -- distinct chats retrieving ≥1 URL from the domain
  citation_count      UInt64,
  total_chat_count    UInt64   -- chats in scope (denominator)
) ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(run_date)
ORDER BY (project_id, run_date, domain, prompt_id, channel_id, country_code, topic_id);

CREATE TABLE url_daily (
  project_id LowCardinality(String), run_date Date,
  url_normalized String, domain LowCardinality(String),
  prompt_id String, topic_id String,
  channel_id LowCardinality(String), country_code LowCardinality(FixedString(2)),
  retrieval_count UInt64,      -- distinct CHATS that retrieved this URL
  citation_count  UInt64
) ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(run_date)
ORDER BY (project_id, run_date, url_normalized, prompt_id, channel_id, country_code, topic_id);
```

> **Note the deliberate asymmetry:** for `domain_daily`, `retrieval_count` counts *URL retrievals* (a chat pulling 3 pages from nytimes.com contributes 3). For `url_daily`, `retrieval_count` counts *chats*. This is the single most error-prone definition in the product; §8.2 pins the resulting formulas exactly. Tag your test fixtures with a case that has multiple URLs from one domain in one chat.

`tag_id` is intentionally **absent** from rollups. Tags are many-per-prompt; materializing them would double-count. Tag filtering resolves `tag_id → prompt_id[]` in Postgres, then filters rollups by `prompt_id IN (...)`. See §8.5.

### 5.10 Postgres — remaining entities (abbreviated DDL)

The following tables follow the same conventions; full columns are specified in their own sections.

| Table | Owner section | Purpose |
|---|---|---|
| `action`, `action_step`, `action_status_event` | §9 | Actions engine, lifecycle, Impact markers |
| `fact`, `claim`, `claim_verdict` | §10.3 | Fact-checking |
| `perception_run`, `perception_attribute`, `perception_cluster`, `perception_score`, `perception_objection`, `perception_source` | §10 | Brand Perception |
| `global_brand`, `product`, `product_category`, `product_offer`, `merchant`, `shopping_attribute` | §11 | AI Shopping |
| `log_integration`, `ga_connection`, `ga_referral_daily` | §12 | Agent Analytics |
| `dashboard_view`, `dashboard_widget`, `share_link` | §15.2 | Composable dashboards |
| `export_job` | §13.9 | Async CSV exports |
| `audit_log` | §19.4 | Who changed what |

---

## 6. Collection layer

### 6.1 Scheduling model

One cron per project, fired at a **deterministic per-project offset** so load spreads across the day:

```
offset_minutes = hash(project_id) % 1440
```

For each fire:

```
for prompt in active_prompts(project):            # is_archived = false
  for channel in active_channels(project):
    if prompt.country_code in channel.unsupported_country_codes: skip  # do NOT create a chat
    if project.frequency == 'weekly' and not is_project_run_day(project, today): skip
    enqueue collect_job {
      job_key: sha256(project_id, prompt_id, channel_id, country_code, run_date)   # idempotency
      priority: channel.surface_kind == 'ui' ? LOW : NORMAL
    }
```

**Rules:**
- `job_key` MUST be the BullMQ job ID so a re-fired cron cannot double-collect a day.
- Unsupported (channel, country) pairs produce **no chat row at all** — not an error chat. A missing chat must never depress a visibility denominator.
- Weekly-frequency projects run on a stable weekday derived from `hash(project_id) % 7`.
- A prompt created mid-day MUST be collected immediately (first-run) rather than waiting for tomorrow, so the customer sees data within minutes of setup.
- Collection MUST be resumable: a worker crash re-runs only incomplete `job_key`s.

### 6.2 Adapter interface (NORMATIVE)

```ts
// packages/adapters/src/types.ts
export interface EngineRequest {
  prompt: string;
  countryCode: string;      // ISO 3166-1 alpha-2; drives egress + locale
  language?: string;
  channelId: string;
  modelId: string;
  runDate: string;          // YYYY-MM-DD, project timezone
  seed?: string;            // simulator determinism
}

export interface RawSource {
  url: string;
  title?: string;
  /** Was this URL referenced inline in the visible answer? */
  cited: boolean;
  /** How many inline references pointed at it. */
  citationCount: number;
  /** 1-based index of the first inline reference, if cited. */
  citationPosition?: number;
  /** Position in the engine's own source list. */
  retrievalRank: number;
}

export interface RawAd {
  advertiserName: string;
  adUnitType: string;
  adsRequestId?: string;
  targetUrl: string;
  cards: { title: string; body?: string; imageUrl?: string; targetUrl: string }[];
}

export interface RawProduct {
  name: string;
  brand?: string;
  merchant?: string;
  position: number;
  price?: { amount: number; currency: string };
  rating?: number;
  attributes?: Record<string, string | number | boolean>;
  queries?: string[];       // shopping queries that surfaced it
}

export interface EngineResponse {
  status: 'ok' | 'empty' | 'error' | 'blocked';
  errorCode?: string;
  /** The visible assistant answer, markdown-normalized. */
  text: string;
  sources: RawSource[];
  /** Background searches the engine ran. */
  fanouts: { text: string; type: 'search' | 'shopping' | 'synthetic' }[];
  ads: RawAd[];
  products: RawProduct[];
  maps: { name: string; url?: string }[];
  features: Feature[];      // engine-reported; enricher may add more
  /** Everything needed to reproduce/audit this capture. */
  raw: unknown;
  meta: { modelReported?: string; latencyMs: number; surfaceKind: 'ui'|'api'|'simulator' };
}

export interface EngineAdapter {
  readonly channelId: string;
  readonly surfaceKind: 'ui' | 'api' | 'simulator';
  readonly capabilities: {
    fanouts: boolean; ads: boolean; shopping: boolean; maps: boolean;
    geo: 'full' | 'partial' | 'none';
    citationsDistinctFromSources: boolean;
  };
  run(req: EngineRequest): Promise<EngineResponse>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}
```

**Every adapter MUST populate `sources` with `cited` and `citationCount` distinctly.** If an engine cannot distinguish them (some APIs return a flat list), set `cited=false, citationCount=0` for uncited entries and record `capabilities.citationsDistinctFromSources = false`. Reports MUST hide citation metrics for channels where that capability is false rather than reporting a misleading zero.

### 6.3 The simulator adapter (build this first)

Purpose: make the entire product runnable, seeded, demonstrable and CI-testable with **zero credentials and zero network**. This is not a stub — it must produce data rich enough that every chart, table, empty state and algorithm in the product is exercised.

Design: a **deterministic pseudo-random generator keyed on `sha256(seed, prompt, channelId, countryCode, runDate)`**, so the same inputs always yield the same output. This makes tests reproducible and lets the demo dataset be regenerated identically.

```
function simulate(req, world):        # world = seeded market model, see below
  rng = mulberry32(sha256(req.seed, req.prompt, req.channelId, req.countryCode, req.runDate))

  # 1. Decide whether this engine ran a web search today (channel-specific base rate).
  didSearch = rng() < world.channel(req.channelId).searchRate

  # 2. Pick which brands appear. Each brand has a latent "strength" per topic per channel;
  #    convert to an appearance probability, then sample WITHOUT replacement.
  candidates = world.brandsFor(topicOf(req.prompt))
  appearing  = sampleByStrength(candidates, rng, k = 3 + floor(rng()*5))

  # 3. Order them: higher strength → earlier, with deliberate noise so Position moves day to day.
  ordered = shuffleWeighted(appearing, rng, temperature = 0.35)

  # 4. Compose an answer paragraph naming them in order, with sentiment-bearing adjectives
  #    drawn from a per-brand sentiment distribution (mean from world, ±0.15 noise).
  text = renderAnswer(ordered, world, rng)

  # 5. Sources: only if didSearch. Draw from a per-topic domain pool with a power-law
  #    (a few dominant domains, long tail), then decide cited vs merely retrieved (~55% cited).
  #    ~20% of chats MUST retrieve 2+ URLs from the same domain (exercises retrieval_rate > 1).
  sources = didSearch ? drawSources(world, rng) : []

  # 6. Fanouts: 0 if !didSearch or !capabilities.fanouts, else 3–12 templated variants.
  # 7. Ads: only for ad-capable channels in ad-enabled countries, ~12% of commercial prompts.
  # 8. Products: only for shopping-capable channels on prompts whose intent is commercial
  #    /transactional AND that name something shoppable.
  # 9. Inject realistic failure modes: ~1.5% 'error', ~0.5% 'blocked', ~3% 'empty'.
  return response
```

The **`world`** is a seeded market model committed as a fixture (`packages/adapters/src/simulator/world.ts`): a set of realistic industries, each with 6–12 brands carrying latent per-topic/per-channel strength and sentiment means, plus a domain pool tagged with the classification each domain should resolve to. This is what makes the demo data *tell a story* — one brand leading on ChatGPT but absent on Perplexity, a competitor gaining over 60 days, a Reddit thread that dominates a topic's citations.

The world model MUST include **trend generators** so time series are not flat: assign each brand a slow drift plus one scripted step change (e.g. brand C gains 8 points of visibility from day 45 onward) so the Impact view and "trending/losing" tables have real signal.

### 6.4 `api` adapters

One adapter per provider, each mapping the provider's native response onto `EngineResponse`.

| Adapter | Provider call | Sources available? | Notes |
|---|---|---|---|
| `openai-api` | Responses API with `web_search` tool | yes, via tool-call annotations | citations parseable from annotations |
| `anthropic-api` | Messages API with `web_search_20250305` | yes | citations in content blocks |
| `perplexity-api` | Sonar chat completions | yes (`search_results`) | strongest source fidelity of any API |
| `google-api` | Gemini API with Google Search grounding | yes (`groundingMetadata`) | grounding chunks + supports map to citations |
| `xai-api` | Grok with Live Search | yes | |
| `mistral-api`, `deepseek-api`, `qwen-api` | chat completions | usually no | mark `citationsDistinctFromSources = false` |

Requirements common to all `api` adapters:
- Respect provider rate limits with a token-bucket per provider held in Redis.
- Retry `429`/`5xx` with exponential backoff and jitter, max 4 attempts, then record `status='error'` with `error_code`.
- Persist the *unmodified* provider payload to object storage before mapping. Mapping bugs are then fixable by reprocessing.
- **Geo:** most APIs ignore geography. Set `capabilities.geo = 'none'` and record `country_code` as the *requested* market for grouping, while surfacing in the UI that this channel does not truly localize. **Never inject location text into the prompt** to fake geography — it silently changes what you are measuring and corrupts cross-market comparisons.

### 6.5 `ui` adapters

Playwright, one browser context per job, logged out, human-plausible pacing.

```
async run(req):
  ctx = await pool.acquire({ country: req.countryCode })   # geo-pinned egress
  page = await ctx.newPage()
  await page.goto(channel.entryUrl, { waitUntil: 'domcontentloaded' })
  await dismissConsentBanners(page)                        # GDPR interstitials per region
  await typeLikeHuman(page, channel.inputSelector, req.prompt)
  await page.keyboard.press('Enter')
  await waitForStreamComplete(page, channel)               # stability heuristic, NOT a fixed sleep
  html = await page.content()
  await store.put(rawKey, html)                            # ALWAYS store before parsing
  parsed = channel.parse(page, html)                       # per-channel DOM extractor
  return parsed
```

Hard requirements:

1. **Store raw HTML + a screenshot before parsing, always.** Consumer UIs change weekly; the raw capture is the only way to repair history.
2. **Per-channel parsers are versioned** (`extractor_version` on `chat`). A parser change bumps the version and triggers reprocessing of affected days.
3. **Selector-drift alarms.** Each parser declares invariants ("an answer body exists", "source list present when a search ran"). If the invariant failure rate for a channel exceeds 2% over 15 minutes, page on-call and mark the channel degraded in the UI rather than silently writing empty chats. **Silently writing empty chats is the worst possible failure**, because it looks like a real visibility drop to the customer.
4. **`waitForStreamComplete` must be a stability heuristic** (DOM mutation quiesced for N ms AND the stop-generating control disappeared), never a fixed sleep.
5. **Geo egress** via per-country proxy pools. Set `Accept-Language` and timezone to match the country. Health-check egress IP geolocation before each job; a mismatched exit node invalidates the country dimension.
6. **Concurrency per (channel, country)** is capped and jittered. Aggressive parallelism is what gets a channel blocked.
7. **Consent/interstitials** — a European run that captures a cookie wall instead of an answer must be classified `status='blocked'`, not `'empty'`.

### 6.6 Failure taxonomy

`chat.status` is a first-class analytic dimension, not just logging.

| Status | Meaning | Counts in visibility denominator? |
|---|---|---|
| `ok` | answer captured | **yes** |
| `empty` | engine answered with no brands and no sources (legitimate; common when ChatGPT doesn't search) | **yes** |
| `error` | transport/provider failure, retries exhausted | **no** |
| `blocked` | bot detection, consent wall, geo refusal | **no** |

Only `ok` and `empty` may contribute to `visibility_total`. Counting `error` chats as "brand not mentioned" manufactures fake visibility drops — this is the single most damaging correctness bug the product can have. Encode it as a test.

### 6.7 Credit accounting

Cost is charged at **enqueue** time, not completion, and mirrors the commercial model exactly:

```
credits(project, month) = active_prompts × active_channels × run_days_in_month
# daily  → run_days = days in month (≈30)
# weekly → run_days ≈ days/7  (≈ one third of daily cost)
```

Credits are **allocation slots, not consumption** — they do not reset monthly and are never "spent". The scheduler MUST refuse to enqueue beyond the project's allocation and surface a quota banner in the UI. See §16.3.

---

## 7. Extraction & enrichment pipeline

Runs once per collected response. Every step is a pure function in `packages/core/src/extraction/`, taking the `EngineResponse` plus project configuration and returning fact rows. Steps are ordered; later steps may read earlier outputs.

### 7.1 Brand detection

This is the highest-stakes algorithm in the product: every headline metric depends on it, and both false positives ("Apple" the fruit) and false negatives (missed alias) are visible to customers immediately.

#### 7.1.1 Matching rules

```
function detectBrands(text, brands):
  matches = []
  for brand in brands:
    # 1. regex takes precedence if present, and is CASE-SENSITIVE by design
    if brand.match_regex:
      for m in text.matchAll(new RegExp(brand.match_regex, 'g')):     # NO 'i' flag
        matches.push({ brand, index: m.index, len: m[0].length, via: 'regex' })
      continue
    # 2. otherwise tracked_name + aliases, CASE-INSENSITIVE, whole-token
    for term in [brand.tracked_name, ...brand.aliases]:
      pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(term)}(?![\\p{L}\\p{N}])`, 'giu')
      for m in text.matchAll(pattern):
        matches.push({ brand, index: m.index, len: m[0].length, via: 'term' })

  matches = dropOverlaps(matches)        # longest match wins; ties → earliest
  matches = dropInsideUrls(matches, text) # ignore hits inside markdown link targets
  return groupByBrand(matches)
```

Details that matter:

- **Whole-token boundaries via Unicode lookarounds**, not `\b`. `\b` breaks on accented and CJK text, and would match "Apple" inside "pineapple" only accidentally correctly.
- **Case-insensitive for names/aliases, case-sensitive for regex.** This asymmetry is deliberate and must be documented in the UI: regex is the escape hatch for dictionary-word brands (`(?<![a-z])Apple(?![a-z])`) and for distinguishing `US` the country from `us` the pronoun.
- **Overlap resolution: longest wins.** Prevents "Bank" matching inside "Deutsche Bank" when both are tracked.
- **Ignore matches inside URLs**, or every chat citing `hubspot.com/blog` inflates HubSpot's mentions.
- **Untracked brand discovery** runs alongside: an LLM pass (or NER + capitalization heuristic) extracts *all* organisation-like entities from the answer. These are written to `chat_brand_mention` with `brand_id=''`, `is_tracked=0`, and a normalized `brand_key`. This is what powers both correct Position (§7.2) and competitor suggestions (§7.1.3).

#### 7.1.2 Test corpus requirement

Ship a fixture corpus of ≥200 hand-labelled answer snippets in `packages/core/test/fixtures/brands/`, including: dictionary-word brands, possessives ("HubSpot's pricing"), hyphenation, brands inside URLs, brands inside code blocks, CJK and accented names, brand-in-brand overlaps, plural forms. Brand detection MUST hold **≥0.98 precision and ≥0.95 recall** on this corpus in CI. This gate is not optional; without it the metric layer is unfalsifiable.

#### 7.1.3 Competitor suggestion

```
nightly per project:
  counts = SELECT brand_key, count(DISTINCT chat_id) FROM chat_brand_mention
           WHERE project_id = ? AND is_tracked = 0 AND run_date >= today - 30
           GROUP BY brand_key
  for (key, n) in counts where n >= 2 and not rejected_before(key):
    upsert brand_suggestion { name: canonicalize(key), mention_count: n, source: 'chat' }
```

Threshold is **two or more mentions** — one is noise. Rejected suggestions are never re-suggested. Also surface `source='competitor'` suggestions: brands frequently co-mentioned with an already-tracked competitor but not with the customer.

#### 7.1.4 Historical recompute

When a brand's matching config changes:

```
1. set brand.recompute_state = 'queued'  (API returns 409 on further matching-field edits)
2. enqueue recompute { project_id, brand_id, from = earliest chat }
3. worker streams chats in run_date order, batched 5k:
     re-run detectBrands on chat.response_text for THIS brand only
     rewrite that brand's chat_brand_mention rows
     re-derive position for ALL brands in each touched chat (positions are relative!)
     mark affected (project, run_date) partitions dirty
4. rebuild dirty rollup partitions
5. set recompute_state = 'idle'; notify the user in-app
```

Step 3's "re-derive position for ALL brands" is essential — adding one alias can change every other brand's rank in every affected chat.

### 7.2 Position assignment

```
function assignPositions(mentions):        # mentions across ALL brands in ONE chat
  ordered = mentions.sortBy(m => m.firstCharIdx)     # order of FIRST appearance
  ordered.forEach((m, i) => m.position = i + 1)
```

**Position ranks over every brand detected, tracked or not.** If a chat names Hyundai, Chevrolet, then BMW, BMW is position 3. If tomorrow Ferrari — untracked — appears ahead of BMW, BMW becomes position 4. This is a defining product decision: it yields true competitive position rather than a flattering rank limited to a self-selected competitor set. Document it prominently in the UI, because customers *will* ask why their position dropped when they added no competitors.

Refinements:
- Order by first appearance, not by mention count.
- If the answer contains an explicit ordered list (`1.`, `2.`, …) and every brand appears within it, prefer list order over character order — models often introduce brands in prose before ranking them.
- Position is recorded only for chats where the brand appears; it never has a value for absent brands (hence separate `position_sum`/`position_count`).

### 7.3 Sentiment scoring

Scored **per (chat, brand)** on the language *around* that brand's mentions, not on the whole answer.

```
function scoreSentiment(text, mention, brand):
  windows = mention.indices.map(i => sentenceWindow(text, i, radius = 1))  # ±1 sentence
  raw = llmSentiment(windows.join(' '), brand.display_name)   # returns float in [-1, +1]
  return clamp(raw, -1, 1)
```

- Store `sentiment_raw ∈ [-1, +1]` on the fact rows. **Never store the 0–100 value.**
- Display value: `score_100 = ((mean(sentiment_raw) / 2) + 0.5) * 100`. Neutral (`0`) maps to **50**; that is why real-world scores cluster in the 65–85 band. Do not "fix" this by rescaling — the linear map must stay stable or historical comparisons break.
- Aggregate from `sentiment_sum / sentiment_count`, never by averaging pre-averaged scores.
- Use a small, cheap model with a strictly-typed output schema and a fixed prompt template versioned as `sentiment_model_version`. Changing the template requires a backfill; treat it like a migration.
- Cache by `hash(window_text, brand_name, template_version)` — the same boilerplate recurs constantly and this cuts LLM cost by an order of magnitude.

### 7.4 Sources and citations

#### 7.4.1 URL normalization (NORMATIVE)

Wrong normalization silently splits one page into many rows and destroys every source metric.

```
function normalizeUrl(raw):
  u = new URL(raw)
  u.protocol = 'https:'                        # collapse http/https
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '')
  u.hash = ''
  strip tracking params: utm_*, gclid, fbclid, msclkid, ref, ref_src, source,
                         mc_cid, mc_eid, igshid, si, _hsenc, _hsmi, vero_*, yclid
  resolve known redirect wrappers (vertexaisearch grounding redirects, news.google.com,
                                   t.co, bing /ck/a, l.facebook.com) to their target
  sort remaining query params alphabetically
  drop trailing slash unless the path is exactly '/'
  decode unreserved percent-escapes; keep case of path (paths ARE case-sensitive)
  return u.toString()
```

Keep `url` (as returned) *and* `url_normalized` (the join key). Reports group by `url_normalized`; the UI links to `url`.

#### 7.4.2 Sources vs citations

- Every URL the engine retrieved → one `chat_source` row.
- `citation_count` = number of inline references in the visible answer pointing at it. `0` means retrieved but not cited.
- **A URL cited multiple times yields one row with `citation_count > 1`**, not multiple rows.
- `citation_position` = index of its first inline reference, enabling "cited early vs. buried".

#### 7.4.3 Page content and on-page brand mentions

For each newly seen `source_page`:

```
1. fetch with a declared, honest User-Agent; obey robots.txt; 10s timeout; 2 retries
2. extract main content → markdown (Readability-style); store to object storage
3. run detectBrands(markdown, project.brands) → chat_source.mentioned_brand_ids
4. compute heuristic_url_classification (§7.6) and heuristic_domain_classification (§7.5)
5. refresh at most every 14 days (content_hash short-circuits reprocessing)
6. on failure store fetch_status; mentioned_brand_ids stays EMPTY and the page is marked
   'unreadable' — the UI MUST render "unknown", never "brand not mentioned"
```

`mentioned_brand_ids` is what makes **Gap Analysis** possible: a source that names competitors but not you. The unreadable/absent distinction matters — asserting "your brand is not on this page" when the fetch 403'd is a wrong claim the customer will act on.

Respect the same constraint the engines have: **only HTML is readable.** Paywalled and JS-only content is invisible; state this in the UI rather than reporting it as a content quality problem.

### 7.5 Domain classification

Layered, cheapest first:

```
function classifyDomain(domain, page, project):
  if override = projectOverride(project, 'domain', domain): return override    # 1
  if matchesAny(domain, ownBrand(project).domains):        return 'OWN'        # 2 (derived)
  if matchesAny(domain, competitorDomains(project)):       return 'COMPETITOR' # 2 (derived)
  if seed = SEED_LIST[domain]:                             return seed         # 3
  if tld in ('.gov','.edu','.mil') or domain ends '.ac.uk': return 'INSTITUTIONAL'
  if domain in UGC_PLATFORMS:                              return 'UGC'
  if domain in REFERENCE_PLATFORMS:                        return 'REFERENCE'
  if hasNewsSignals(page):                                 return 'EDITORIAL'  # 4
  if looksCorporate(page):                                 return 'CORPORATE'
  return llmClassifyDomain(domain, page.title, page.sample) ?? 'OTHER'         # 5
```

- **Seed list** (~2,000 curated domains: reddit.com→UGC, wikipedia.org→REFERENCE, nytimes.com→EDITORIAL, g2.com→REFERENCE, youtube.com→UGC, …) resolves the overwhelming majority of real traffic at zero cost. Ship it in `packages/registry`.
- `hasNewsSignals`: `article:published_time`, `NewsArticle` JSON-LD, `/20\d{2}/\d{2}/` path patterns, bylines.
- `looksCorporate`: `Organization` JSON-LD, `/pricing`, `/about`, `/careers` present at the root.
- LLM fallback is cached permanently per domain and never re-run without a version bump.
- `RELATED` is reserved for domains the customer's org owns but that aren't the primary brand domain (microsites, regional TLDs).

### 7.6 URL classification

Page-type classification. Sequenced pattern-matching first, LLM only for the residue.

| Class | Primary signals |
|---|---|
| `HOMEPAGE` | path is `/` or a bare locale segment (`/en/`) |
| `CATEGORY_PAGE` | `CollectionPage`/`ItemList` JSON-LD, `/category/`, `/shop/`, faceted params, product-grid density |
| `PRODUCT_PAGE` | `Product` JSON-LD with `offers`, `/product/`, `/p/`, `/dp/`, single price + add-to-cart |
| `LISTICLE` | title matches `/^(top\|best)\s+\d+/i` or `/\b\d+\s+(best\|top)\b/i`, many `h2` siblings with ordinals |
| `COMPARISON` | title contains ` vs ` / ` versus `, comparison table with 2+ product columns |
| `ALTERNATIVE` | title matches `/alternatives?\s+to\|best .* alternatives/i` |
| `PROFILE` | directory hosts (g2.com, capterra.com, crunchbase.com, yelp.com, trustpilot.com) with an entity path |
| `DISCUSSION` | reddit/StackExchange/forum paths, `DiscussionForumPosting` JSON-LD, threaded comment DOM |
| `HOW_TO_GUIDE` | `HowTo` JSON-LD, title starts `How to`, ordered step headings |
| `ARTICLE` | `Article`/`BlogPosting` JSON-LD, byline + published date |
| `OTHER` | none of the above |

Order matters: check `COMPARISON` and `ALTERNATIVE` **before** `ARTICLE`, and `PROFILE` before `HOMEPAGE`. Both classifications are per-project overridable (§5.7) and overrides propagate everywhere the source appears, including historical reports.

### 7.7 Fanout capture

```
for (i, f) in response.fanouts:
  insert chat_fanout { query_index: i, query_text: normalizeQuery(f.text), query_type: f.type }
```

- `search` — a normal web search. `shopping` — a product/shopping-feed search (these decide carousel contents). `synthetic` — a query the model composed for itself rather than issuing verbatim.
- `normalizeQuery`: trim, collapse whitespace, lowercase for grouping, but **retain the original casing for display**.
- Only capture for channels with `capabilities.fanouts`. Absence must render as "not supported by this engine", never as zero.
- Derive **common terms** per group by tokenizing, removing stopwords plus the customer's own brand terms, and counting document frequency across distinct fanouts.

### 7.8 Chat features

Flags on every chat, computed from adapter output plus text heuristics:

| Feature | Detection |
|---|---|
| `WEB_SEARCH` | engine reported a search, or ≥1 source exists |
| `AD` | ≥1 sponsored unit parsed |
| `MAP` | map/local-pack unit present |
| `SHOPPING` | product carousel present |
| `PRODUCT_COMPARISON` | comparison table naming ≥2 brands/products |
| `IMAGE` | inline image results present |

Features are **independent of whether the customer's brand appears** — that is their value. They are aggregated as percentages at prompt and topic level ("42% of chats for this prompt included ads", "80% triggered a web search") and MUST be filterable in the chats table, API and MCP exactly like model/country/date.

### 7.9 Ads extraction

Each sponsored unit → one `chat_ad` row per creative card. `creative_hash = sha256(advertiser + card_title + card_body + image_url)` defines a "unique creative" for counting. Resolve `advertiser_brand_id` by running brand matching over the advertiser name so ads join to tracked brands.

Derived metrics (§15.9): advertisers in market, *bidding on your brand* (advertisers appearing on prompts tagged `branded` or classified `COMPARISON`), ad coverage (% of tracked prompts showing ≥1 ad), and **spend tier** — a coarse `High|Medium|Low` from tercile-binning `distinct_prompts × appearance_frequency` across advertisers in the project. It is an estimate; label it as such in the UI.

### 7.10 Prompt system classification

On prompt creation, asynchronously assign exactly one value per system group. `NULL` renders as "classifying…" and MUST self-heal.

```
branding:   'branded'      if the prompt text mentions the own brand OR any tracked competitor
            'non-branded'  otherwise
intent_type: 'informational'  — seeks understanding ("what is CRM software")
             'commercial'     — compares options ("best project management tools", "X vs Y")
             'transactional'  — near decision ("HubSpot pricing", "buy", "where to get")
```

Implement `branding` deterministically with the brand matcher (cheap, exact, and it must update when brands change). Implement `intent_type` with a cheap LLM classifier plus a keyword prior. Both are user-reclassifiable per prompt but cannot be renamed as groups.

The canonical analytic move this unlocks — and the UI should suggest it — is filtering to **non-branded + commercial** to read true discovery performance, since branded prompts almost always mention you and inflate visibility.

### 7.11 Brand profile extraction

On project creation from a domain:

```
1. fetch homepage + /about + /pricing + /products (follow nav, max 8 pages, obey robots.txt)
2. extract to markdown; truncate to a token budget
3. single LLM call with a strict output schema → brand_profile fields
4. present in an onboarding step for human correction BEFORE generating anything
5. on save: enqueue topic-suggestion + prompt-suggestion refresh
```

The profile is the seed for topics, prompts, competitor guesses and Perception's industry. Garbage here propagates everywhere, so the human-review step is mandatory, not optional.

### 7.12 Prompt volume (1–5)

A **relative-to-industry** demand score, deliberately not a global absolute volume.

```
function promptVolume(prompt, project):
  themes  = extractThemes(prompt.text)                 # 2–5 head terms
  raw     = Σ_theme searchVolume(theme, prompt.country_code) × relevanceWeight(theme, project)
  cohort  = volumeDistribution(project.industry, prompt.country_code)   # cached percentiles
  pct     = percentileOf(raw, cohort)
  return  pct < 0.20 ? 1 : pct < 0.40 ? 2 : pct < 0.60 ? 3 : pct < 0.80 ? 4 : 5
```

- `searchVolume` comes from a keyword-data provider (DataForSEO / Semrush / Google Ads Keyword Planner). Behind an interface with a **deterministic offline implementation** so the simulator path works without a vendor.
- `relevanceWeight` upweights business-specific terms over generic ones.
- Scoring against an industry cohort rather than a global average is the point: "high volume" for enterprise fintech and for consumer footwear are different absolute numbers.
- Recompute monthly; label the feature **beta** in the UI.

---

## 8. Metric engine (NORMATIVE)

Implement once, in `packages/core/src/metrics/`. The dashboard, public API, MCP server, CSV exports and the BI connector MUST all call the same builder. Any second implementation will drift and produce two different numbers for the same question — the fastest way to lose customer trust in an analytics product.

### 8.1 Brand metrics

| Metric | Formula | Range | Better |
|---|---|---|---|
| `visibility` | `visibility_count / visibility_total` | 0–1 | higher |
| `share_of_voice` | `mention_count / Σ mention_count over all in-scope brands` | 0–1 | higher |
| `position` | `position_sum / position_count` | ≥1 | **lower** |
| `sentiment` | `((sentiment_sum / sentiment_count) / 2 + 0.5) × 100` | 0–100 | higher |
| `mention_count` | Σ mentions | ≥0 | higher |

Where:
- `visibility_count` = distinct chats in scope in which the brand appeared ≥1 time.
- `visibility_total` = distinct chats in scope with `status IN ('ok','empty')` — **independent of the brand**. Every tracked brand in the same scope shares the same denominator.
- `mention_count` = total occurrences, so a brand named three times in one answer contributes 3 (this is what makes SoV differ from Visibility).

**Visibility vs Share of Voice** must be explained in the UI, because it is the most common source of customer confusion. Worked example: your brand appears in 4 of 10 chats → Visibility 40%. In those chats you are mentioned 4 times and a competitor 12 → SoV = 4/(4+12) = 25%. Visibility measures presence; SoV measures competitive prominence.

### 8.2 Source metrics

Read the asymmetry in §5.9 first.

**Domain-level:**

| Metric | Formula | Meaning |
|---|---|---|
| `retrieved_percentage` | `retrieved_chat_count / total_chat_count` | share of chats where ≥1 URL from the domain was retrieved |
| `retrieval_rate` | `retrieval_count / total_chat_count` | average URL retrievals from the domain per chat; **may exceed 1.0** |
| `citation_rate` | `citation_count / retrieved_chat_count` | average inline citations per chat in which the domain was used |
| `total_citations` | `Σ citation_count` | raw citation volume |
| `citation_share` | `citation_count / Σ citation_count over all domains in view` | share of the citation landscape |

**URL-level:**

| Metric | Formula |
|---|---|
| `retrieval_count` | distinct chats that retrieved the URL |
| `citation_rate` | `citation_count / retrieval_count` |

> **The trap, stated explicitly.** For domains there are two different denominators, and picking the wrong one is an easy, silent bug:
> - `citation_rate = citation_count / retrieved_chat_count` ← **correct**, "citations per response that used this domain"
> - `citation_count / retrieval_count` ← this is a *per-retrieval* average, a different statistic. Expose it, if at all, only as a clearly-named legacy field (`citation_avg`), never as `citation_rate`.
>
> For URLs the two coincide, because `url_daily.retrieval_count` already counts chats. Write an explicit unit test: one chat retrieving 3 URLs from `example.com` with 4 total inline citations must yield `retrieval_rate = 3.0`, `retrieved_percentage = 1.0`, `citation_rate = 4.0`.

**Gap Score** (drives Gap Analysis and the Actions engine):

```
gap_score(source) =
      log1p(retrieval_count)                    # how often the model uses it at all
    × (competitor_brands_mentioned / max(1, tracked_competitor_count))   # breadth of rivals present
    × (own_brand_mentioned ? 0 : 1)             # only a gap if you are ABSENT
    × (1 + citation_rate)                       # cited sources matter more than background ones
```

Normalize to 0–100 within the current view for display. A high score means: the model leans on this source often, it names several of your competitors, it does not name you, and it is genuinely cited. That is the definition of an actionable gap.

### 8.3 Aggregation rules

**Ratios MUST be recombined from their component sums, never averaged.** Every rollup therefore stores numerator and denominator separately:

```
sentiment       = ((Σ sentiment_sum / Σ sentiment_count) / 2 + 0.5) × 100
position        =   Σ position_sum   / Σ position_count
visibility      =   Σ visibility_count / Σ visibility_total
share_of_voice  =   brand.mention_count / Σ mention_count      (within the row's grouping)
citation_rate   =   Σ citation_count  / Σ retrieved_chat_count  (domain)
retrieval_rate  =   Σ retrieval_count / Σ total_chat_count
```

Averaging daily percentages weights a Tuesday with 12 chats the same as a Monday with 400. The API MUST publish these formulas in its endpoint descriptions so integrators recombining rows get the same answers as the dashboard.

### 8.4 Dimensions

```
prompt_id | topic_id | tag_id | model_id (deprecated) | model_channel_id
country_code | chat_id | date | week | month
```

Semantics: a report always breaks down by its own entity (brands report → one row per brand; domains → per domain; URLs → per URL). Requesting `["tag_id","model_channel_id"]` on the brands report yields one row per **(brand × tag × channel)** — not per (tag × channel).

- `week` buckets start Monday (ISO); `month` buckets on the first of the month. Both in project timezone.
- The UI MUST default to breaking down by `model_channel_id` on every comparison view. An aggregate number routinely hides "dominant on ChatGPT, invisible on Perplexity", which is the single most common actionable finding in the product.

### 8.5 `filters` vs `having` (NORMATIVE)

Two filter stages with different semantics. Getting this wrong produces plausible-looking, wrong numbers.

- **`filters`** — applied **before** aggregation (SQL `WHERE`, pre-`GROUP BY`). They change which chats are counted at all, shrinking **both** numerator and denominator of every ratio.
- **`having`** — applied **after** aggregation (SQL `HAVING`). They select which finished rows are returned and **do not change any metric's value**.

```ts
type Operator = 'in' | 'not_in' | 'has_all' | 'gt' | 'gte' | 'lt' | 'lte';
interface Predicate { field: string; operator: Operator; values: (string|number)[] }

interface ReportRequest {
  project_id?: string;                  // required for company-scoped keys
  start_date: string; end_date: string;
  previous_start_date?: string; previous_end_date?: string;  // explicit comparison window
  dimensions?: Dimension[];
  filters?: Predicate[];
  having?: Predicate[];
  order_by?: { field: string; direction: 'asc'|'desc' }[];
  limit?: number; offset?: number;
}
```

Allowed fields:

| Report | `filters` | `having` |
|---|---|---|
| brands | `model_channel_id, country_code, prompt_id, tag_id, topic_id, chat_id, brand_id` | same + `visibility, share_of_voice, sentiment, position` |
| domains | population fields + `domain, domain_classification, url, url_classification, mentioned_brand_id, mentioned_brand_count, gap` | population + `domain, domain_classification, mentioned_brand_id, mentioned_brand_count, gap` |
| urls | as domains | as domains + `url, url_classification` |

Validation rules the builder MUST enforce:

1. A **population field** (`model_channel_id`, `country_code`, `prompt_id`, `tag_id`, `topic_id`, `chat_id`) used in `having` requires the matching value in `dimensions` — otherwise the column is not in the `GROUP BY`. **Reject with 400**, do not silently ignore.
2. Comparison operators (`gt`…`lte`) are valid only in `having`, only on metric fields.
3. `tag_id` predicates resolve to prompt sets in Postgres first; `has_all` means "prompt carries every listed tag" (AND), `in` means any (OR).

#### 8.5.1 Pitfall 1 — collapsing Share of Voice

`share_of_voice` divides a brand's mentions by all in-scope brands' mentions. Putting `brand_id` in `filters` removes every other brand *before* the denominator is computed, so SoV becomes exactly `1.0` for every row — always, and meaninglessly.

```jsonc
// WRONG: SoV is always 1.0
{ "filters": [ { "field": "brand_id", "operator": "in", "values": ["br_abc"] } ] }

// RIGHT: one brand's row, SoV still measured against every brand in scope
{ "dimensions": ["model_channel_id"],
  "having":  [ { "field": "brand_id", "operator": "in", "values": ["br_abc"] } ] }
```

The builder SHOULD emit a machine-readable warning (`warnings: ["sov_denominator_collapsed"]`) whenever `brand_id` appears in `filters` alongside a requested `share_of_voice`. The same principle applies to `retrieval_rate` and `retrieved_percentage` on the source reports.

#### 8.5.2 Pitfall 2 — double-counting across tags

A prompt can carry many tags (topics cannot — exactly one per prompt, so topics never overlap). Breaking down by `tag_id` means a chat whose prompt has three tags contributes to all three rows. That is correct *for comparing tags*, and wrong the moment a consumer sums those rows to get a project total.

Rule: **never sum tag-level rows to derive a total.** Request the report again without `tag_id` and let the engine aggregate over distinct chats. If both views are needed, make two requests. Document this on every tag-capable endpoint, and have the builder mark tag-dimensioned responses with `additive: false`.

### 8.6 Deltas and change indicators

Every metric row carries a `previous` object. Comparison window resolution:

1. explicit `previous_start_date`/`previous_end_date` if supplied, else
2. the immediately preceding window of equal length.

Direction is metric-aware: `position` improving means the number went **down**. Encode this in one place —

```ts
const LOWER_IS_BETTER = new Set(['position', 'failure_rate', 'gap_score_rank']);
```

— and drive arrow colour from it. A green down-arrow for position is correct and must not be "fixed" by a well-meaning frontend change.

### 8.7 Query builder architecture

```
ReportRequest
  → validate (zod + rules in §8.5)
  → resolve  (tag_id → prompt_id[]; topic_id → prompt_id[] when needed; classifications → predicates)
  → plan     (choose rollup table vs raw facts; choose dialect)
  → compile  (SQL text + bound params)
  → execute  (ClickHouse | Postgres)
  → shape    (rows + previous + warnings + pagination)
```

- **Planning rule:** windows ≤ 7 days with `chat_id` in dimensions read raw facts; everything else reads rollups. Any request touching `mentioned_brand_id`/`gap` reads `chat_source` (rollups don't carry brand arrays).
- **Dialect adapter** so Postgres single-node and ClickHouse share one compiler and one test suite. Golden-SQL snapshot tests per dialect.
- **Caching:** cache key = `hash(project_id, request, max(rollup_watermark))`. Rollup watermark invalidation means edits and late-arriving chats bust the cache correctly without TTL guessing.
- **Row cap:** hard-cap ungrouped result sets (e.g. 50k) and require pagination beyond it; return `total_count` separately.

### 8.8 Rollup maintenance

```
after enrichment of chat C:
   mark (project_id, run_date) dirty in a Redis set
every 60s:
   for each dirty (project, date), recompute that day's brand_daily / domain_daily / url_daily
   from facts and REPLACE the partition slice (idempotent, not incremental increments)
   advance rollup_watermark(project) = max(rollup_watermark, now)
```

Full recompute-per-dirty-day rather than incremental deltas is the right trade: a day is small, and idempotent replacement makes reprocessing, brand recomputes and late arrivals all trivially correct. Incremental increments would require exactly-once semantics you will not achieve.

---

## 9. Actions engine

Actions convert measurement into work. This is the feature that makes the product a decision tool rather than a dashboard, and it is where most clones fall short — the temptation is to emit generic SEO advice. The requirement here is that **every action cites the specific evidence that produced it**.

### 9.1 Action groups

| Group | Meaning | Typical action |
|---|---|---|
| `SITE_AUDIT` | technical/accuracy fixes so crawlers can access and understand your site | unblock `GPTBot` in robots.txt; fix 404s on cited URLs |
| `OWNED` | content on properties you control | publish the comparison page competitors have and you don't |
| `EARNED` | placements to win on third-party sources | pitch a publication cited 14× where you never appear |

Sub-typed by source type: `owned_pages`, `editorial`, `reference` (wikis/directories/databases), `ugc` (forums/review sites/communities). Each maps to a different playbook — PR outreach for editorial, directory claiming for reference, authentic community engagement for UGC, on-page work for owned.

### 9.2 Generation rules

Run weekly per project (plus on-demand with a cooldown). Each rule is a pure function `(evidence) => Action[]`.

```
R1  OWNED / missing page type
    For each (topic, url_classification) where competitors' pages of that type are cited
    ≥ N times in the window and the customer has zero cited pages of that type:
      → "Publish a {url_classification} covering {topic}"
      evidence: competitor URLs + citation counts + window

R2  EARNED / editorial gap
    For each domain with classification EDITORIAL and gap_score above the view's 70th pct:
      → "Pursue coverage on {domain}" + the specific competitor URLs ranking there

R3  REFERENCE / record correction
    For each REFERENCE domain retrieved ≥ N times where the customer is absent or
    mentioned_brand_ids lacks the own brand:
      → "Claim/correct your entry on {domain}"

R4  UGC / community presence
    For each UGC domain with high retrieval and competitor mentions:
      → "Engage in {domain}" + the exact threads

R5  SITE_AUDIT / crawl blocked
    Join Crawlability: any Search-type bot blocked by robots.txt → high-impact action
    (a blocked search bot means the engine structurally cannot cite you)

R6  SITE_AUDIT / crawl errors
    Join Crawl Insights: URLs with bot visits and ≥1 4xx/5xx → "Fix {status} on {url}"

R7  OWNED / retrieved but not cited
    Own URLs with high retrieval_count and citation_rate ≈ 0
      → "Restructure {url} for extractability" (headings, direct answers, tables, freshness)

R8  OWNED / sentiment or fact correction
    Join Fact-checking: contradicted claims with identifiable cited sources
      → "Correct {claim} — cited from {sources}"

R9  SHOPPING / attribute coverage
    Products where the AI's comparison grid has values for competitors and blanks for you
      → "Add {attribute} to {product} PDP"

R10 OWNED / fanout coverage
    High-occurrence fanout queries whose retrieved sources never include your domain
      → "Create content answering {fanout}"
```

### 9.3 Opportunity scoring

```
opportunity_score =
      w1 · normalized_gap_volume        # how much retrieval traffic the gap represents
    + w2 · competitor_density           # how many rivals benefit from it today
    + w3 · topic_importance             # prompt volume × prompt count in the topic
    + w4 · addressability               # OWNED (you control it) > REFERENCE > EARNED
    - w5 · estimated_effort             # technical fix < page edit < new page < earned placement
```

- Publish weights in code with an ADR; do not scatter magic numbers.
- Expose both a continuous `opportunity_score` (for sorting) and a discretized `relative_opportunity_score` (1=Low, 2=Medium, 3=High) for prose labels. The UI shows a 5-band label (`Very low … Very high`) derived from within-project percentiles.
- **One scale across all action types.** A robots.txt fix and a new comparison page must be comparable, because the customer has one queue. The underlying raw numbers are *not* comparable across types — which is exactly why a normalized rating exists. Say so in the tooltip.
- Filters (models, topics, countries, page types, source types, owned/earned) narrow which actions are *shown* and MUST NOT change any action's rating.

### 9.4 Action content

Each action stores:

| Field | Content |
|---|---|
| `overview` | one-sentence statement of the issue or opportunity |
| `why_this_matters` | the evidence, with real numbers: "Competitor comparison pages were cited in 14 conversations about CRM software in the last 30 days, while you have no comparison page covering the topic." |
| `competitor_evidence` | which competitors benefit + the specific contributing source URLs |
| `brief` | suggested content structure (LLM-generated from the evidence, **not** the content itself) |
| `steps` | `action_step[]`, individually checkable |
| `expected_outcome` | relative impact band + the raw supporting stats |
| `additional_context` | anything else the evidence surfaced |
| `scope` | topic, models, country, `your_page` where applicable |

Briefs are generated by an LLM **grounded strictly in the evidence rows**, with the evidence passed in as structured context and a hard instruction not to introduce facts. Store the evidence snapshot alongside the brief so the recommendation remains auditable after the underlying data moves.

### 9.5 Lifecycle and Impact

```
NEW ──accept──► IN_PROGRESS ──complete──► DONE
 │                   │
 └──decline──► DECLINED   └──cancel──► NEW
```

Every transition writes `action_status_event {action_id, from, to, at, user_id}`. The **Impact** view then plots the project's metric time series (visibility default; also sentiment, position, SoV) with day markers: amber when an action entered `IN_PROGRESS`, green when it hit `DONE`. Clicking a marker opens the action beside the graph.

Requirements and honesty constraints:
- Markers land in the bucket where the transition happened; weekly/monthly views may merge several markers into one.
- For completed actions the timestamp is when it was marked done, not the full status history.
- **Do not claim causality.** This is a visual before/after aid, not an attribution model. If you want to go further, offer an explicitly-labelled *estimated* lift using a difference-in-differences comparison against untouched topics as control — and label the uncertainty.
- Actions are visible only to org-level members (`org_member.role IN ('owner','admin','member')`), not per-project guests, because they contain competitive strategy.

---

## 10. Brand Perception subsystem

Perception answers questions your tracked prompts cannot, so it runs on **its own generated prompt set**, independent of the customer's prompts. Consequences that MUST hold throughout:

- Adding or removing tracked prompts does not change Perception results.
- Perception data is **snapshot-per-run, with no date range**. The UI shows "last run N ago" and the next scheduled run; it never offers a date filter.
- The model filter *does* apply.
- The competitor set comes from `brand_profile.industry`. Changing the industry reruns the entire analysis, so the first change is free and subsequent changes are capped (default 3) via `industry_changes_used`.

```sql
CREATE TABLE perception_run (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('market','objections','factcheck')),
  industry text NOT NULL,
  target_market char(2),
  status text NOT NULL CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED')),
  started_at timestamptz, finished_at timestamptz,
  next_run_at timestamptz
);
```

### 10.1 Market — attributes

Two questions are asked, producing two scores that are **on the same 0–100 range but are not comparable**. Keeping them apart is the whole insight.

```
A) "Asked about your brand":     What is {brand} known for?          → association score
B) "Asked about your industry":  Which brands are known for {attr}?  → market prominence
```

Pipeline:

```
1. Generate a probe set per (industry, target_market): N≈40 questions of type A and B.
2. Run each probe across active channels, R repetitions (R≥5) to average out non-determinism.
3. Extract attribute terms from every answer (LLM, strict schema): short qualities like
   "reliable", "great for design teams", "strong security".
4. Cluster terms by embedding similarity into attribute clusters with a human-readable label
   ("Luxury", "Racing Heritage", "Value for money"). Clusters are user-editable:
   rename, delete, reassign members — all in ONE transaction so a cluster can be emptied by
   reassignment and deleted in the same request.
5. Score:
   association(attr, own)      = mean over type-A answers of positional prominence
   market_prominence(brand,attr) = mean over type-B answers of positional prominence
   where positional prominence = 100 for first mention, −10 per rank, 0 below tenth,
   AND answers that never mention it contribute 0 to the mean.
6. Attach sources: every URL retrieved while producing each answer, aggregated per attribute.
```

Derived summary cards (each is a specific, defensible statement):

- **Most associated** — highest association score.
- **Best vs competitors** — attribute where you are closest to its market leader. Note position alone is not the criterion: `#3 of 12` and `#3 of 60` are different achievements, so normalize by the number of brands carrying the attribute.
- **Biggest gap** — high association, low market prominence: AI credits you with it more than the market does. Render as `#1 → #9`; `Unplaced` when you never surface for it in the market at all (the widest possible gap). Requires ≥4 attributes carrying both scores.
- **Strongest competitor** — highest mean market prominence across all attributes.
- Headline sentence: *"AI describes {brand} as {most-associated}, but it competes best on {best-vs-competitors}."*

Visuals: radar "brand shape" (≤3 brands, selectable attributes), attribute-mention bar chart (type A), brand × attribute heat map 0–100 (type B), and an attributes table with your rank, ties sharing a rank, `—` when never mentioned, expanding into the contributing sources with occurrences / retrievals / citation rate / URL type / domain type.

### 10.2 Objections

What AI argues *against* you when a buyer is deciding — product feedback you rarely get any other way.

```
1. Probe: "Why might someone not choose {brand}?" and variants, repeatedly, per channel.
2. Extract each distinct objection phrasing.
3. Cluster by meaning; a cluster's score is the SUM of its member phrasings' scores,
   so a grouped objection can outrank any single phrasing. Show the member count as a badge.
4. Score identically to attributes: first mention 100, −10 per rank, 0 below tenth,
   averaged across EVERY completed run (runs that never raise it drag the average down).
5. Attach the sources retrieved while raising each specific objection — tied to the
   objection, not to the view as a whole.
```

Interpretation guidance the UI must give: a score near 100 means raised consistently and early. A mid-range score is ambiguous — it can mean "very early in some answers, absent in others" or "late in almost every answer" — so tell the user to expand it and use the model filter to distinguish. Three sections: the objection-mentions chart, *Sources behind the view*, and a *Terms* table (exact wording, its cluster, occurrences, which models used it).

The source table mixes two provenances and must label them: **Occurrences** = how many of *this objection's* answers cited the page (from Perception runs); **Retrievals** and **Citation rate** = from the customer's *tracked prompts*. A page can have high occurrences and `—` for citation rate: Perception used it, tracked prompts have not. Untracked pages' rows do not expand.

Best-practice framing to surface in the UI: separate **false** objections (a content and PR problem) from **true** ones (product feedback).

### 10.3 Fact-checking

Compares what AI says about the brand against facts the customer asserts.

```sql
CREATE TABLE fact (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  statement text NOT NULL, is_active boolean NOT NULL DEFAULT true,
  edited_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE claim (
  id text PRIMARY KEY, project_id text NOT NULL, chat_id text NOT NULL,
  prompt_id text NOT NULL, model_id text NOT NULL, brand_id text NOT NULL,
  statement text NOT NULL, category text,            -- pricing | integrations | availability | ...
  claim_hash text NOT NULL,                          -- dedupe identical claims across chats
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE claim_verdict (
  claim_id text NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
  fact_id  text NOT NULL REFERENCES fact(id) ON DELETE CASCADE,
  verdict  text NOT NULL CHECK (verdict IN ('contradicted','supported')),
  fact_statement_at_verdict text NOT NULL,           -- fact text as it was when judged
  overridden_verdict text, overridden_by text, overridden_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (claim_id, fact_id)
);
```

Pipeline:

```
1. Whenever a tracked chat mentions a tracked brand (own OR competitor), extract atomic claims.
   ATOMICITY IS THE POINT: "It starts at $49/mo, integrates with Salesforce, and has 10k
   customers" is THREE claims. A wrong price must not hide inside an otherwise-correct paragraph,
   and a correction needs one specific thing to fix.
2. For each claim, retrieve semantically related active facts (embedding search, top-k).
3. For each (claim, fact) pair judged relevant, LLM returns 'contradicted' | 'supported'
   | 'not_applicable'. Persist only the first two.
4. A claim no fact speaks to gets NO verdict and does not appear as a finding.
```

Step 4's consequence must be made loud in the UI: **AI can be wrong about you for months with nothing appearing here, because you never asserted the fact that would catch it.** The *By fact* view — showing each fact and, for unmatched ones, "Never comes up" — is where that gap becomes visible. Onboarding should prompt for the high-value facts first: starting price, plan contents, supported integrations, guarantees, availability — the ones least likely to be plainly stated on the website and most expensive to have wrong.

Three views: **Contradicted** (newest first, cap 100), **By fact**, **By claim category** (claims / chats / contradicted share per category, expanding to a sample — the row shows volume, the list shows examples). Contradicted share counts only claims that *received* a verdict, so it reads as a share of what was checked rather than drifting each time a fact is added.

A claim detail panel shows the statement, verdict, deciding fact, repetition ("Repeated in 12 chats, across 3 prompts and 2 models"), the original fact wording if since edited, provenance (prompt/model/answered-at), and sources split three ways: **cited for this claim** / **cited elsewhere in the answer** / **retrieved but not cited**. Users may override a verdict; the original stays visible.

---

## 11. AI Shopping subsystem

Product-level rather than brand-level tracking. Scope it to the engines that actually render product carousels (in practice ChatGPT today) and say so in the UI rather than showing empty charts for the rest.

### 11.1 Catalog ingestion

Three paths, all landing in the same tables:

| Path | Mechanism |
|---|---|
| Shopify storefront | fetch `https://{domain}/products.json`, paginate, map variants → products |
| Peec CSV | flat file, one product per row |
| Google Merchant Center feed | accept the standard GMC product feed as-is (CSV/TSV/JSON/XML) |

CSV contract — required `title`, `brand`; optional `description`, `price`, `currency` (ISO 4217), `link`, `imageLink`, `category` (path separated by `" > "`, any depth). UTF-8, comma-separated.

```sql
CREATE TABLE global_brand (         -- shared registry products attach to; DISTINCT from `brand`
  id text PRIMARY KEY, canonical_name text NOT NULL, aliases text[] NOT NULL DEFAULT '{}'
);
CREATE TABLE product_category (
  id text PRIMARY KEY, project_id text NOT NULL, parent_id text REFERENCES product_category(id),
  name text NOT NULL, path text NOT NULL, UNIQUE (project_id, parent_id, name)
);
CREATE TABLE product (
  id text PRIMARY KEY, project_id text NOT NULL, global_brand_id text REFERENCES global_brand(id),
  name text NOT NULL, description text, image_url text, link text,
  catalog_price numeric(12,2), currency char(3),
  price_override numeric(12,2),
  source text NOT NULL CHECK (source IN ('CATALOG','LLM')),   -- LLM = discovered in chats
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, lower(name), global_brand_id)
);
```

Behaviours:
- **Category tree review before commit.** Draft the tree from the upload, show it, let the user adjust, then go live. Categories drive every breakdown and filter, so this step earns its friction.
- **Uploads are additive.** New rows append; nothing is replaced. A single-row CSV is the way to add one product.
- **Backfill on upload:** match new products against the last 30 days of chats so metrics populate immediately rather than starting from zero.
- **`My catalog` vs `All products`** toggle: catalog-only versus every product seen in tracked chats (yours and competitors'). The product is usable with **no** upload at all via `All products` — make that the empty-state call to action.
- Deleting a catalog product removes it from catalog views; chat-discovered products persist under `All products`.

### 11.2 Product matching

Matching noisy AI-mentioned product names to catalog rows:

```
function matchProduct(rawName, brandHint, catalog):
  n = normalize(rawName)     # lowercase, strip punctuation, collapse whitespace,
                             # normalize units (oz/ml, in/cm), strip colour/size qualifiers
  1. exact on normalized name (+ brand if known)          → confidence 1.00
  2. normalized name contains/contained-by a catalog name  → 0.85
  3. trigram similarity ≥ 0.72 within the same brand       → 0.75
  4. embedding cosine ≥ 0.88 within the same category      → 0.70
  else → unmatched: keep the raw name, source='LLM'
```

Persist the confidence and expose an admin review queue for the 0.70–0.85 band. Never silently merge two SKUs — for a merchandising team, wrongly-merged variants are worse than unmatched rows.

### 11.3 Shopping metrics

| Metric | Formula |
|---|---|
| `visibility` | chats mentioning the product / chats in scope |
| `win_rate` | chats where the product is **position 1** / chats where it appears |
| `avg_position` | mean carousel rank when present (lower better) |
| `appearances` | absolute count of chats |
| `mentioned_price` | price the AI quotes (compare against `catalog_price`) |
| `share_of_voice` | product's mentions / all in-scope product mentions |

Reporting requirements:
- Position is the metric to emphasize. Users typically see 2–3 carousel results before scrolling (horizontally, on mobile) — a product that appears often at position 8 is effectively invisible. Say this in the UI.
- **Read win rate alongside visibility**, never alone: "appears often" and "wins the slot" are different problems.
- `mentioned_price` vs `catalog_price` is a genuinely novel, high-value signal — assistants quoting stale prices is common and costly. Surface a dedicated "price drift" view.
- **Co-featured products** = the real competitive set at SKU level. Also a **position vs. competitors box plot** (median, variance, outliers) — a product that rarely appears but ranks well is a completely different situation from one that always appears weakly, and only the distribution shows that.
- **Merchants**: sellers whose offers surfaced, ranked by mentions, share of voice, buy-box win rate, average position, average rating.

### 11.4 Attribute grid

When an assistant compares products it builds an attribute table. Capture and aggregate it:

```
tabs: characteristics (text values) | facts (boolean/numeric specs) | ratings (scored scales)
scope: product (columns = competing products or brands) | overview (whole catalog)
columns are FIXED per product, ranked by attribute overlap with yours
```

The actionable read is the **empty cell**: competitors have a value for an attribute and you don't, meaning the model could not find that information about your product. That maps directly to Actions rule R9 (§9.2) — add it to the PDP.

### 11.5 Shopping demand

Two distinct query buckets that must never be conflated:

- **Shopping queries** — product/shopping-feed searches that decide *which products fill the carousel*. These overlap heavily with Google Shopping intent, so they double as a merchandising feed.
- **Fanout queries** — regular web searches that shape the *prose, reasoning and comparisons around* the carousel.

Expose both with `top | trending | losing | new` modes over a date range, groupable by topic or prompt.

---

## 12. Agent Analytics

Three features that connect AI answers back to the customer's own infrastructure. Together they let the product distinguish three otherwise-indistinguishable failure modes: *the bot cannot reach the page* (technical), *it reaches it but never uses it* (content), *it uses it but you aren't tracking the prompts where that matters* (coverage blind spot).

### 12.1 Crawlability

Zero-setup `robots.txt` analysis against a registry of AI user-agents. No integration, no data connection — this MUST work on any domain immediately, which makes it the natural top-of-funnel feature.

```
function crawlability(domain, bots):
  txt = fetch(`https://${domain}/robots.txt`)        # follow ≤2 redirects; 404 ⇒ all Allowed
  groups = parseRobots(txt)                          # RFC 9309
  for bot in bots:
    g = groups.forAgent(bot.userAgent)               # most-specific match wins
    if !g: g = groups.forAgent('*'); reason = 'inherited from wildcard'
    else:  reason = 'explicit rule for this bot'
    status = g.disallows('/') ? 'Blocked'
           : g.hasAnyDisallow() ? 'Partial'
           : 'Allowed'
    yield { bot, platform: bot.vendor, type: bot.type, status, reason }
```

Requirements:
- `parseRobots` MUST implement RFC 9309 properly: longest-match precedence between `Allow` and `Disallow`, wildcards `*` and end-anchor `$`, case-insensitive agent matching, and correct group merging when several `User-agent` lines share one block. Unit-test against the RFC examples.
- **URL Tester**: enter any URL on the domain and show which bots may fetch *that path*.
- Bot registry (≈49 agents across 20+ vendors) with `type ∈ {training, search, user_query, other}` — see **Appendix B (§22.2)**. Label the categorization as best-effort based on published vendor documentation.
- The most important derived insight, wired into Actions R5: a blocked **search-type** bot means the engine structurally cannot cite you, regardless of content quality. Rank that above any content recommendation.

### 12.2 Crawl Insights (server logs)

Ingest real access logs, keep only AI-bot traffic, and join it to prompt-tracking data by URL.

**Eight ingestion paths**, all filtering non-AI traffic *at ingest* so customer PII never lands in the system:

| Path | Mechanism |
|---|---|
| AWS CloudFront | CloudFormation stack deployed into the customer's account; reads CF access logs, filters, forwards |
| Google Cloud CDN | one-line script creating a Cloud Logging sink + Cloud Function filter/forwarder |
| Cloudflare | Worker deployed to the customer's zone via their API token (needs `Workers Scripts:Edit`, `Zone:Read`, `Workers Routes:Edit`) |
| Vercel | Log Drain created with an Account API token (explicitly *not* an AI Gateway key) |
| WordPress | generated plugin with credentials embedded; skips admin/cron/health paths; resolves real client IP behind proxies |
| Akamai | DataStream created via EdgeGrid credentials; delivers every 30s |
| Generic webhook | customer POSTs batches to `POST /agent-analytics/generic-access-log` |
| File upload | CSV or Common Log Format, parsed in-browser-triggered background job |

Generic webhook contract:

```
POST https://api.<host>/agent-analytics/generic-access-log
Authorization: Bearer <api-key>
x-org-id: <organization-id>
Content-Type: application/json

[ { "timestamp": "2026-01-15T12:34:56Z",   // required, ISO 8601
    "request_method": "GET",                // required
    "request_url": "https://example.com/blog/my-post",  // required, full URL
    "response_status": 200,                 // required, 100–599
    "user_agent": "GPTBot/2.0",             // required, raw UA
    "country_code": "US",                   // optional
    "client_ip": "1.2.3.4",                 // optional
    "referer": "https://some-site.com/" } ] // optional
```

Max **500 entries per request**. Reject the batch with per-entry error detail rather than silently dropping rows.

Processing:

```
for entry in batch:
  bot = matchBot(entry.user_agent)     # registry match, longest-token-first
  if !bot: DISCARD (never stored)
  if orgMonthlyVisits(org) >= plan.botVisitLimit: DISCARD + set quota_exhausted flag
  insert agent_log { ..., bot_id, bot_vendor, bot_type, request_folder: firstPathSegment(url) }
```

Quotas are **org-level, not per project** (e.g. 4M–45M bot visits/month by plan). When exhausted, stop storing for the remainder of the month, resume on the 1st, and **explicitly tell the user in the UI that the resulting gap means "limit reached", not "no bot activity"** — otherwise they will misread a billing artifact as a crawl collapse.

Dashboard: filters (date, platform, bot type, bot); KPIs (total bot visits, active bots, failure rate = share of 4xx/5xx, top folder, top URL); crawl activity over time (hourly only within a ≤3-day window, else daily/weekly/monthly); breakdowns by platform / bot / bot type; and a **Visited URLs table** that is the payoff — per URL: bot visits, platforms, status codes, **plus `retrievals`, `citation_rate` and `topics` from prompt tracking on the same row**. Label the prompt-side columns clearly as independent of bot activity.

Baseline status codes (`200, 301, 302, 304, 307, 308, 401, 403, 404, 410, 429, 500, 502, 503, 504`) always render even at zero, so a customer can see the absence of errors.

Operational warnings that MUST be in the setup UI:
- Cloudflare's free Workers tier caps at 100k requests/day and **fails closed by default**, meaning a high-traffic site will serve error pages to real visitors once the cap is hit. Tell them to set the route to *Fail Open* or upgrade. This is the single most dangerous integration in the product.
- Disconnecting stops syncing but does not delete history; deletion is a separate, irreversible action in a danger zone.

### 12.3 AI Referrals (GA4)

Closes the loop from "we are visible in AI answers" to "AI sends us traffic that converts".

```
1. Google OAuth → select GA4 property + web data stream (ONE property per project)
2. Daily pull via the GA4 Data API, scoped to hosts the project owns
3. Classify each session's source as an AI assistant:
      GA4's native AI-assistant channel grouping
   ∪  own regex/domain registry (Appendix C, ~100 assistant domains)
4. Store into ga_referral_daily, dimensioned and metricized as below
```

Dimensions: `assistant, platform, source, medium, country, device, event_name, landing_page, page_path, host`.
Metrics: `events, session_starts, conversions, revenue` (plus derived `sessions`, `engagement_rate`, `avg_engagement_time`, `conversion_rate`).

Definitional precision the UI must carry, because these names are shorter than their meanings:

- `session_starts` = GA4 `session_start` events — **not** GA4's `sessions` metric. The two legitimately differ. Cannot be combined with `group_by=event_name`.
- `conversions` = GA4 **key events**, so one visit can contribute several, and what counts depends entirely on what the customer marked as a key event.
- `conversion_rate` = session key event rate; empty unless key events are configured.
- `engagement_rate` = share of engaged sessions (≥10s, or ≥1 conversion, or ≥2 page views).
- `revenue` = purchase revenue in the property's reporting currency; return `currency` alongside and **never convert or compare across projects**.
- `landing_page` = session entry page, repeated on every event in the session. `page_path` = where the event fired, with query strings stripped and UUIDs collapsed to `*` — so **the two do not join**. Document this or users will build broken funnels.
- Unknown dimension values come back as `(not set)`; that is a real row.

**Mandatory honesty about coverage.** A `Channels` view MUST show where AI traffic hides that this feature cannot measure:
- **Organic Search** — Google AI Overviews and AI Mode are classified by GA4 as organic search, not referral, so AI-driven visits live in here.
- **Direct** — mobile AI apps and links that pass no referrer land here.

Therefore the AI Assistants number is a **floor, not a total**. State it on the page. Over-claiming here destroys the credibility of the one number executives care about.

---

## 13. Public REST API

### 13.1 Shape

- Base: `https://api.<host>/customer/v1`
- JSON only. `snake_case`. OpenAPI 3.0 generated from the zod schemas in `packages/contracts` and served at `/openapi/json` — the spec is generated, never hand-maintained.
- Report endpoints are `POST` (complex bodies); entity endpoints are REST (`GET/POST/PATCH/DELETE`).

### 13.2 Authentication

- `x-api-key: <key>` header (preferred) or `?api_key=` query param (documented as less secure).
- Keys are **company-scoped** (all projects; `project_id` then required in each request) or **project-scoped** (single project; `project_id` optional and validated if given).
- Store `argon2id` hashes; show plaintext exactly once; look up by `key_prefix`.
- Errors: `{"message":"Missing API Key"}` → 400, `{"message":"Invalid API Key"}` → 401, wrong project → 403.

### 13.3 Rate limits

- **200 requests/minute per project**, sliding window in Redis.
- Always return `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (seconds).
- Over limit → `429` with `Retry-After`. Document exponential backoff.

### 13.4 Report endpoints

```
POST /reports/brands     → §8.1 metrics per brand
POST /reports/domains    → §8.2 domain metrics
POST /reports/urls       → §8.2 URL metrics
POST /sources/urls/content → scraped markdown of a source URL
```

Response envelope:

```jsonc
{
  "data": [ { /* dimension keys + metrics + "previous": {...} */ } ],
  "total_count": 128,
  "warnings": ["sov_denominator_collapsed"],
  "meta": { "additive": true, "rollup_watermark": "2026-09-05T09:00:00Z" }
}
```

Every report endpoint's OpenAPI `description` MUST embed (a) the aggregation formulas, (b) the `filters` vs `having` semantics, and (c) the two pitfalls from §8.5.1–§8.5.2. Integrators and LLM consumers read the spec, not the docs site, and these are the mistakes they will otherwise make.

### 13.5 Entity endpoints

```
GET    /projects
GET    /brands                       POST /brands
PATCH  /brands/{id}                  DELETE /brands/{id}
GET    /brands/suggestions           POST /brands/suggestions/{id}/{accept|reject}
GET    /prompts                      POST /prompts
PATCH  /prompts/{id}                 DELETE /prompts/{id}
POST   /prompts/{id}/archive         POST /prompts/{id}/unarchive
GET    /prompts/suggestions          POST /prompts/suggestions/generate
GET    /prompts/suggestions/generations/{id}
POST   /prompts/suggestions/{id}/{accept|reject}
POST   /prompts/suggestions/update            # edit pending discovery suggestions in place
GET    /topics  POST /topics  PATCH /topics/{id}  DELETE /topics/{id}
POST   /topics/generate                        # propose, save nothing
GET    /tags    POST /tags    PATCH /tags/{id}   DELETE /tags/{id}
GET    /tag-groups  PATCH /tag-groups/{group}  DELETE /tag-groups
GET    /models (deprecated)          GET /model-channels
GET    /chats                        GET /chats/{id}/content
POST   /queries/search               POST /queries/shopping
GET    /project-profile              PUT  /project-profile
GET/POST/DELETE /classifications/{domains|urls}
PUT    /classifications/{domain|url}-assignments
GET    /agent-analytics/{bots|logs|visits}
GET    /agent-analytics/google-analytics/{referrals|list-referral-sources}
POST   /products/{list|detail|summary|trend|performance|demand|merchants|attributes}
POST   /products/{create|update|delete}
GET/POST/PATCH/DELETE /categories...
GET    /global-brands                POST /global-brands
GET    /brand-perception/{brand-attributes|attribute-rankings|attribute-sources
        |competitive-breakdown|objections|objection-sources|industries|attribute-clusters}
POST   /brand-perception/attribute-clusters/edit
GET    /actions                       # overview + drill-down scopes, §9
```

### 13.6 Batch semantics (NORMATIVE)

Batch endpoints (`create_products`, `update_prompts`, `create_categories`, …) **MUST NOT fail as a whole**. Each item is independent:

```jsonc
{
  "created":  [ { "id": "prd_01", "name": "..." } ],
  "skipped":  [ { "id": "prd_02", "reason": "no_changes" } ],
  "rejected": [ { "index": 3, "reason": "name_conflict" } ]
}
```

Reason enums must be stable and specific: `not_found`, `no_changes`, `duplicate_id`, `name_conflict`, `parent_not_found`, `category_not_found`, `brand_not_found`, `invalid_move`, `invalid_tag`, `not_editable`. Cap batches at **50 items**. This design is what makes the MCP server usable — an agent editing 40 prompts must not lose 39 successes to one typo.

### 13.7 Async operations

Long operations return a job id immediately and are polled:

```
POST /prompts/suggestions/generate → { "generation_id": "..." , "status": "QUEUED" }
GET  /prompts/suggestions/generations/{id} → { "status": "RUNNING|SUCCEEDED|FAILED", ... }
```

Same pattern for chat exports, catalog imports, log-file uploads and Perception runs.

### 13.8 Versioning

- Path-versioned (`/customer/v1`). Additive changes only within a version.
- Deprecations are marked in OpenAPI with `deprecated: true` and a `x-deprecated-reason`, kept for ≥2 releases, and listed in a machine-readable changelog endpoint.
- `model_id` filtering is deprecated from day one in favour of `model_channel_id`; ship it deprecated rather than discovering the need later.

### 13.9 Exports and BI connector

- **CSV export** of any report view, and a full chat archive per project, via async `export_job` producing a signed URL.
- **BI connector endpoint** exposing a flat, connector-friendly schema for Looker Studio / Data Studio community connectors, authenticated by a project-scoped API key:
  - dimensions: `brand, country_code, date, model, model_channel_id, prompt, source_domain, source_domain_classification, source_url, source_url_classification, tag, topic, workspace`
  - metrics: `citation, retrieval, retrieval_percentage, visibility, sentiment, position, usage, sov`

---

## 14. MCP server

Lets the customer query and manage the product conversationally from Claude, Cursor, VS Code, Windsurf. In practice this is also the highest-leverage surface for power users, so treat it as a first-class product, not an afterthought.

### 14.1 Connection

| Property | Value |
|---|---|
| URL | `https://api.<host>/mcp` |
| Transport | Streamable HTTP |
| Auth | OAuth 2.0 (browser consent, session persists) **or** Personal Access Token as `Authorization: Bearer` |

Tokens act as the *user*, so every call respects exactly the same project and org-owner permissions as that user's dashboard session. There is no separate MCP permission model — one authorization path, one audit trail.

### 14.2 Read tools (~33)

```
list_projects  list_brands  list_topics  list_tags  list_tag_groups
list_models  list_model_channels  list_prompts  list_chats  get_chat
list_search_queries  list_shopping_queries
get_brand_report  get_domain_report  get_url_report  get_url_content
list_products  get_product  get_shopping_attributes  get_shopping_summary
get_shopping_trend  list_shopping_demand  list_shopping_performance
list_categories  list_global_brands  list_merchants
list_bots  get_agent_visits
list_domain_classifications  list_url_classifications
get_actions  get_project_profile
search_docs  read_doc
```

Design notes that make the difference between a usable and a frustrating MCP server:

- **`get_url_content`** returns the scraped markdown of a cited source — "what did the AI actually read". This is the tool that makes source analysis conversational instead of tab-hopping.
- **`get_actions` is deliberately two-step:** `scope=overview` first to find the biggest opportunity slice, then `scope=owned|editorial|reference|ugc` (with the `url_classification` or `domain` surfaced by the overview row) for the textual recommendations. Enforce it in the tool description so the model doesn't fetch everything.
- **`search_docs`/`read_doc`** serve your own documentation so the assistant can explain a metric without hallucinating a formula.
- Every report tool's description MUST restate the §8.5 pitfalls. LLMs will otherwise filter by `brand_id` and confidently report 100% share of voice.
- Prefer `model_channel_id` in all tool schemas; mark `model_id` deprecated in the description text.

### 14.3 Write tools

```
create_brand / update_brand / delete_brand           (+ *_brands batch forms)
create_prompt / update_prompt / delete_prompt         (+ batch, archive, unarchive)
create_tag / update_tag / delete_tag                  (+ batch, tag groups)
create_topic / update_topic / delete_topic            (+ batch)
create_products / update_products / delete_products
create_categories / update_categories / delete_categories
set_domain_classification / set_url_classification
update_project_profile
```

Requirements:
- Every write tool declares `readOnlyHint: false`; every delete declares `destructiveHint: true`, so clients prompt for confirmation before executing.
- Writes require **org-owner** access on the project.
- Batches capped at 50, with the per-item `{created, skipped, rejected}` semantics from §13.6.
- Every write emits an `audit_log` row attributing the change to the user *and* to the MCP client.

### 14.4 MCP prompts (slash commands)

Ready-made workflows, each a scripted sequence of tool calls with formatted output:

| Command | Produces |
|---|---|
| `peec_weekly_pulse` | week-over-week visibility/SoV/position/sentiment + biggest movers + notable new sources |
| `peec_competitor_radar` | competitor deltas, where they gained, which sources drove it |
| `peec_engine_scorecard` | per-channel performance table, highlighting engines where you underperform |
| `peec_topic_heatmap` | topic × channel matrix with outliers called out |
| `peec_prompt_grader` | prompts ranked by volume × visibility gap; flags low-value tracked prompts |
| `peec_source_authority` | top domains by citation share, gap-ranked outreach targets |
| `peec_campaign_tracker` | metrics for a tag/topic across a window vs a baseline |

Each MUST also work when combined with free-form follow-ups ("now do that for Germany only").

---

## 15. Frontend specification

### 15.1 Information architecture

```
/                                   marketing (public)
/pricing  /pricing-agencies  /docs  /blog  /changelog
/login  /signup  /onboarding

/p/[projectId]
├── overview                        Home — composable widget dashboard (default landing)
├── brand
│   ├── insights                    single-brand deep dive
│   └── perception
│       ├── market                  attributes vs market
│       ├── objections
│       └── fact-checking
├── prompts
│   ├── index                       all prompts (Active | Suggested | Archived)
│   └── discovery                   guided prompt-set builder
├── sources
│   ├── gap-analysis
│   ├── domains        /domains/[domain]
│   └── urls           /urls/[urlHash]
├── actions
│   ├── index                       Site audit | Owned | Earned
│   └── impact
├── results
│   ├── ranking
│   ├── chats          /chats/[chatId]
│   ├── fanouts
│   └── ads
├── agent-analytics
│   ├── crawl-insights /crawl-insights/details
│   ├── crawlability
│   └── ai-referrals
├── shopping
│   ├── overview
│   └── products       /products/[productId]
└── settings
    ├── profile  brands  tags  facts
    └── company: settings  projects  api-keys  connected-apps  members  billing
```

Global sidebar behaviours: collapsible groups; project switcher at top; `⌘K`/`Ctrl+K` command palette searching **pages, prompts, domains, URLs and projects** in one index; Browse/Chat tabs to toggle the in-app agent panel; Settings pinned at the bottom; account menu with theme (light/dark/system) and referral program.

### 15.2 Global filter bar

Present on every analytics page, persisted in the URL query string (shareable links MUST reproduce a view exactly) and in `localStorage` per project:

| Filter | Behaviour |
|---|---|
| Date range | default **last 7 days**; presets + custom; drives all delta comparisons |
| Model / channel | multi-select over the project's active channels |
| Country | appears only once >1 country exists among prompts |
| Topic | multi-select |
| Tags | multi-select with explicit **AND/OR** toggle; appears only once tags exist |
| Brand / competitor | context-dependent (single-select on Insights, multi on Overview) |
| Branding / Intent | single-select each (system tag groups) |
| Features | multi-select over `AD, MAP, SHOPPING, PRODUCT_COMPARISON, WEB_SEARCH, IMAGE` |

Progressive disclosure is a requirement, not a nicety: hide filters that cannot yet do anything (no tags → no tag filter). A wall of inert filters on day one is the main reason analytics onboarding fails.

### 15.3 Overview — composable dashboard

- **Widget grid**: 12-column, drag to reorder, drag edges to resize (6 cols = half row, 12 = full), min sizes enforced, sections addable, per-widget `⋯` menu → delete / save as image / copy image / export CSV.
- **Widget catalog** drawn from every subsystem: Brand KPIs, visibility over time, own-source impact (visibility overlaid with your domains' retrieved %), top recommended actions, brand insights, source distribution by type, top domains, recent chats, perception attributes, fanouts, keywords, shopping/products.
- **Layouts are personal** — one user rearranging must not affect colleagues.
- **Views**: named saved layouts with optional description, created from scratch or generated by AI from a text description; browsable All/Bookmarked; searchable; teammates' views openable; unfinished ones saved as drafts. Bookmarks are personal and appear in the sidebar; the default Overview cannot be bookmarked.
- **Sharing**: toggle produces a public read-only link, optionally password-protected. The link always shows *live* data — for a frozen snapshot the user exports **PDF**. Turning sharing off permanently invalidates that link; re-enabling mints a new one. Implement share links as opaque tokens in `share_link` with an optional argon2 password hash, and serve them through a route that cannot access any mutation.

Default (non-customized) layout, in order: Brand KPI row (visibility, SoV, position, sentiment, retrieved %, avg citation rate) → visibility-over-time line chart with top 6 competitors → brands table → top recommended actions → source distribution by type + top domains → recent chats.

### 15.4 Prompts

Tabs **Active | Suggested | Archived**, prompts grouped by topic (ungrouped under "No Topic"), with `active / plan limit` shown at the top.

Columns (all toggleable, reorderable, sortable, with "reset to default view"): prompt text, visibility, sentiment, position, mentions (brand avatars), **volume** (1–5 coloured bar with tooltip), tags, branding, intent, location, added date, and the feature percentages — shopping %, product comparison %, images %, ads %, map %, web search %. Feature columns must carry a tooltip stating they are independent of whether your brand is mentioned.

Batch actions via checkboxes (with shift-range selection and select-all-on-page): assign tags, assign topic, archive (from Active); assign tags/topics, activate, delete (from Archived). Search filters before selection.

Creation: single/multi-line manual entry (one prompt per line) with location, topic and tags; **bulk CSV** (col 1 prompt ≤200 chars, col 2 ISO country, col 3 topic, cols 4+ one tag each, header row ignored, UTF-8, comma or semicolon); and suggestion acceptance. Provide a downloadable template.

Clicking a prompt opens a **per-prompt dashboard**: same layout as Overview but scoped, no tag filters, a competitor selector that appends brands to the graph and table (showing true rank even when outside the top 7, e.g. `#36`), fanout queries with common terms, and recent chats in table form.

**Lifecycle copy must be unambiguous** because it maps to billing and data loss: Active = runs daily, counts to limit; Archived = stops running, keeps all history, does not count; Deleted = erases everything as if it never existed.

### 15.5 Prompt Discovery

Four-step wizard, then a review surface.

1. **Profile** — what you sell, buyer personas, plus optional free-text steering (≤200 chars).
2. **Markets** — locations and languages; prompts are generated per market.
3. **Topics** — review suggested topics *before* any prompts are generated; rename, delete, add.
4. **Distribution** — branded vs unbranded share and intent mix; each set must total 100%. Defaults: **20% branded**, **25/50/25** informational/commercial/transactional.

Results page: topic sidebar (regroupable by branding, intent, persona, market or language to inspect coverage from different angles); accept/reject individually or **Activate all** per group; `Generate more prompts`; `Modify setup`. Topics split into **Suggested** (nothing accepted yet — where every topic starts) and **Active** (≥1 accepted), with hover counts. A **coverage overview** compares what was accepted against the requested distribution, marking each topic/country/persona `On target`, `Not started`, or empty.

Accepted prompts count against the plan limit — warn before bulk activation.

### 15.6 Brand Insights

Single-brand deep dive, brand chosen from the top filter.

- **KPIs**: visibility, SoV, sentiment, position, plus **strongest/weakest model** (combined rank across visibility, sentiment and position).
- **Trend graph**: toggle metric; overlay your domains' **retrieved percentage** with a domain selector, so brand authority and domain authority can be read together; vertical markers for events (new prompts created, model change).
- **Performance matrix**: configurable two-axis grid over `models | brands | topics | tags | countries`, up to 10 items per axis with search and top-N presets, heat-mapped by the selected metric, every cell's tooltip showing all four metrics, draggable column order. This is the highest-value analytical surface in the product — it answers "which topics do I own on ChatGPT but not Perplexity?" in one glance.
- **Top rankings**: columns are rank positions `#1..#n`, cells hold the brand at that rank for a chosen dimension (model/topic/tag/country), own brand highlighted.
- Every section: save/copy as image, export CSV.

### 15.7 Sources

**Domains page** — source retrieval by domain over time (top 5), sources-type chart (citations by domain category), **movers** (`Top | New | Trending | Losing`), and the domain table: source, domain type (with `You`/`Competitor` shown for owned/tracked domains), retrieved %, retrieval rate, total citations, citation share, citation rate, plus a **Gap Analysis** toggle revealing a Gap Score column. Inline classification editing via a search-first picker that allows creating a custom type inline; overridden rows are visually marked and resettable. Bookmark column with a `Bookmarked` tab.

**URLs page** — same structure at page level, plus URL type classification, `Mentions` (brands named on the page), retrievals, citation rate, and `Updated` (last fetch). Sources-type chart here breaks down page types.

**URL detail page** — title + link; overview metrics with period deltas (citation rate, retrievals, prompts using it, first/last seen); retrievals over time; retrievals by model; prompts table (which prompts triggered it, and their topics); brands mentioned on the page with frequency; chats where it was used; and **View page content** showing the exact markdown the models read.

**Gap Analysis page** — cross-cutting view of domains and URLs where competitors are named and you are not, sorted by Gap Score, with prioritization guidance by source type (editorial → PR; corporate → partnerships/listings; UGC → community engagement; reference → correct the record; own → structure and AI-readability).

### 15.8 Fanouts

Two headline stats — **distinct fanout queries** and **total occurrences** — then a table of every captured fanout: AI model, exact query, type (`Search | Shopping | Synthetic`), occurrences. `Group by` toggles **Topics** (default) or **Prompts**. A common-terms panel shows the most frequent terms across fanouts. Where a channel does not support fanouts, render an explicit "not supported by this engine" state.

### 15.9 Ads

KPIs: advertisers in market, bidding on your brand, ad coverage, prompts with ads, average prompts per advertiser. Charts: ad presence over time (your brand vs others) and ad share (with a **biggest movers** toggle).

Advertisers table with three views — **All advertisers** (creatives, topics, ad visibility, spend tier, times seen), **All ads** (flattened creatives), **Tracked brands** (limited to tracked brands). Hover previews the full creative with its sponsored label; clicking opens the source chat. Search by advertiser or destination URL, filter by spend tier, export CSV.

Below: **bidding on your brand** chart (advertisers on your branded/comparison prompts) and an **ads by topic/prompt** table with a mentioned/not-mentioned filter — the highest-value view, because it isolates prompts where a competitor advertises *and* you are organically absent.

State plainly that ad tracking is ChatGPT-only and limited to the supported countries; do not render empty charts for unsupported engines.

### 15.10 Actions

Grouped **Site audit | Owned | Earned** with counts, regroupable by *What to do*, *Earned vs Owned*, or *Topics*. Status filter (`All | New | In progress | Declined | Deleted`) and bulk `Accept all` per group. Filters for models, topics, countries, page types, source types, platforms, owned/earned.

Action detail: overview, topic, models, country, your page, **why this matters** (with the real numbers), **competitor evidence**, **the brief**, **what to do** (checkable steps), **expected outcome** with the relative impact band, additional context. Accept → In progress; Decline; Cancel; Done.

Refresh on a schedule with a manual `Generate actions` button and a visible cooldown after each manual run.

**Impact** sub-page: metric graph (visibility default; sentiment/position/SoV switchable) filterable by date, tag, model, country, topic; amber/green day markers for status changes; an action tracker listing the actions behind those markers, click-through to detail beside the graph.

### 15.11 Agent Analytics UI

- **Crawlability** — bot table (bot, platform, type, status, reason) with in-table search and platform/type/status filters, plus the **URL Tester**. No setup required; make this the first thing a trial user can succeed at.
- **Crawl Insights** — connection wizard for the eight integrations (§12.2), then the dashboard and the **Details** page with the visited-URLs table joining bot data to retrievals/citation rate/topics. Settings for provider migration and an irreversible data-deletion danger zone.
- **AI Referrals** — Overview (KPI cards, AI traffic by assistant over time with daily/weekly/monthly toggles, breakdowns by source/landing page/country/device) and Details (Channels view with the honesty callouts from §12.3, and a landing-page breakdown toggling **Event page** vs **Session path** with an explanation of why their metrics differ). Settings for the GA connection, reauthentication, and deletion.

### 15.12 Shopping UI

**Overview** — brand/product toggle on a combined graph (visibility, position, SoV, win rate over time), top 7 brands or products, performance by visibility, shopping queries and shopping fanout queries (`top | trending | losing | new`). Empty state must offer *"continue without uploading"* and explain that `All products` already works from tracked chats.

**Products table** — per product: visibility, win rate, position, appearances, catalog price, mentioned price, competing brands/products, top shopping queries, top fanout queries, attributes. Filters by category, merchant, brand, country, model channel, topic, tag; `My catalog` / `All products` source switch.

**Product detail** — KPIs with deltas; co-featured products; position-vs-competitors box plot; shopping queries; fanout queries; attribute grid with `Characteristics | Facts | Ratings` tabs; prompts table (visibility/position/win rate per prompt, so losing prompts are obvious); chats table.

### 15.13 In-app agent

A side panel (Browse/Chat tabs) that answers questions against the project's own data by calling the same tools as the MCP server. Requirements: company context and project context injected automatically; user memory; pre-built **Skills** (reports, diagnostics) and custom skills; and — critically — **every answer cites the underlying rows or chats it used**, with click-through. An analytics assistant that cannot show its work is worse than no assistant.

### 15.14 Cross-cutting UI requirements

- **Empty, loading and error states for every surface.** Empty states must be actionable ("no chats yet — your first run completes within 24h"), not decorative.
- **First-24-hours experience**: a project with prompts but no chats yet must show a clear "collecting" state everywhere, with an ETA, not zeros. Zeros look like failure.
- **Desktop and mobile layouts.** Tables collapse to cards below `md`; charts stay legible.
- **Accessibility**: keyboard-navigable tables and filters, visible focus, ARIA on charts with a data-table fallback, contrast-checked colours. Brand colour pickers must not be the only channel distinguishing series — use dashes/markers too.
- **Dark mode** across every chart and table.
- **Number formatting** in one shared module: percentages 1 decimal, position 1 decimal, sentiment integer, counts locale-grouped, currency with the reporting currency's symbol. Deltas always show direction, magnitude and metric-aware colour (§8.6).
- **Real copy.** No lorem, no "Welcome to your app".

---

## 16. Auth, tenancy, plans and quotas

### 16.1 Roles

| Scope | Role | Capabilities |
|---|---|---|
| Org | `owner` | everything, incl. billing, API keys, all writes via API/MCP |
| Org | `admin` | all projects, no billing |
| Org | `member` | all projects read/write; sees Actions |
| Org | `guest` | only explicitly granted projects |
| Project | `editor` | edit that project's config |
| Project | `viewer` | read-only — the agency "client seat" |

Enforce in a single authorization module (`packages/core/src/authz`) consumed by api, web and mcp. **Actions are hidden from project-only guests** (competitive strategy). Write operations through API and MCP require org `owner`.

### 16.2 Auth methods

Email+password with verification, Google OAuth, magic links; **SSO/SAML** for enterprise tiers; TOTP 2FA. Sessions are httpOnly, secure, SameSite=Lax cookies with rotation. Invites are org- or project-scoped.

### 16.3 Plans, credits, quotas

Two commercial tracks, both metering the same underlying resource.

**Brand plans** gate: active prompts, number of active channels (choose-N vs all), projects, countries per project, tracking frequency, plus feature gates (BI connector, API, MCP, SSO).

**Agency plans** are credit-based:

```
1 prompt × 1 model × 1 day = 1 credit
1 prompt × 1 model × 1 month (30 days) = 30 credits
weekly tracking ≈ ⅓ of daily cost
```

Credits are **allocation slots, not consumption**: they are computed automatically from (prompts × models × frequency) per project, they do **not** reset monthly, and they are never "spent". Agencies raise/lower prompts and models per project and the credit figure follows. Enforce a minimum allocation per project (e.g. 900 credits) so projects are viable.

Implementation requirements:

- A single `quota.ts` module answers: `canActivatePrompt`, `canEnableChannel`, `canCreateProject`, `canAddCountry`, `canIngestBotVisit`, `canCallApi`. Every write path consults it — quota checks scattered across routes will diverge from billing.
- **Agency pitch projects** are first-class (`project.status = 'PITCH'`) with their own smaller prompt allowance, so agencies can prospect. They convert to `CUSTOMER` in place, preserving history.
- **Pausing** a project stops all prompts, frees its allocation for reassignment, and **loses the data for the paused period irrecoverably** — the confirmation dialog must say so.
- Bot-visit limits are **org-level**; on exhaustion stop storing and show the "limit reached, not zero activity" banner (§12.2).

---

## 17. Seed data and demo mode

A data product is unevaluable when empty. `pnpm seed` MUST produce a complete, believable, *interesting* dataset in under two minutes with no credentials.

```
pnpm seed --industry saas-crm --days 90 --prompts 60 --channels 6 --countries US,DE,GB
```

What it must generate:

1. An org, an owner user, two projects (one brand-plan `CUSTOMER`, one agency `PITCH`).
2. A brand profile, 5 topics, 60 prompts across topics with realistic branding/intent distribution and volume scores.
3. An own brand + 6 competitors with aliases, one requiring regex (a dictionary word).
4. 90 days × 60 prompts × 6 channels × countries of simulated chats — roughly 100k+ chats — via the simulator adapter, then run the **real enrichment pipeline** over them. Never fabricate metrics directly; always go through extraction so seeding also tests the pipeline.
5. A source universe of ~400 domains across every classification, with a realistic power-law citation distribution, some multi-URL-per-chat cases, and pages whose fetch "fails" so the unreadable state is exercised.
6. Scripted narratives so the UI has stories to tell: a competitor overtaking the customer around day 45; one channel where the customer is invisible; a Reddit thread that becomes the dominant citation in one topic; a page that loses citations after day 60; an accidental `GPTBot` block in robots.txt; two contradicted claims; one product priced wrongly by the AI.
7. Ads on ~12% of commercial prompts, with 8 advertisers across spend tiers.
8. A 40-product catalog with categories, plus chat-discovered competitor products.
9. Agent logs (~2M rows) including 404s and a 5xx spike, and GA-style referral data with conversions and revenue.
10. Actions generated by the real engine over the seeded data; a few already accepted/completed so **Impact** shows markers.
11. Perception runs (market, objections, fact-checking) with facts and claims.

Every random draw is seeded from a single `--seed` value so the dataset is byte-reproducible — essential for screenshot tests and for debugging "the chart looks wrong".

---

## 18. Testing strategy

| Layer | Tool | Requirement |
|---|---|---|
| Extraction algorithms | Vitest + fixture corpora | brand matching ≥0.98 precision / ≥0.95 recall (§7.1.2); URL normalization, classification, robots parsing all fixture-driven |
| Metric engine | Vitest, golden numbers | hand-computed expectations for every formula in §8; the multi-URL-per-domain case; error/blocked chats excluded from denominators |
| Query builder | snapshot SQL per dialect | identical results from Postgres and ClickHouse paths on the seeded dataset |
| API contract | schema tests from `packages/contracts` | every endpoint validates request+response against zod; OpenAPI regenerated and diffed in CI |
| Batch semantics | Vitest | partial success never fails the batch; every reason enum reachable |
| Authorization | Vitest matrix | every role × every route; cross-tenant access attempts return 404 (not 403 — do not leak existence) |
| Adapters | contract tests | each adapter satisfies the same `EngineResponse` invariants; recorded-fixture replay for `ui` parsers |
| E2E | Playwright | onboarding → prompts → first chats → overview → sources → action accept → impact marker |
| Visual | Playwright screenshots on the seeded dataset | catches chart regressions that unit tests cannot |
| Load | k6 | report endpoint p95 < 800ms at 90-day windows on a 10M-chat project |

**Non-negotiable correctness tests** (each maps to a bug that would silently mislead a paying customer):

1. `error`/`blocked` chats never enter `visibility_total`.
2. `brand_id` in `filters` triggers the SoV warning; in `having` it does not collapse SoV.
3. Summing tag-dimensioned rows ≠ the untagged total when prompts are multi-tagged, and the response is marked `additive: false`.
4. Position counts untracked brands.
5. Domain `citation_rate` divides by `retrieved_chat_count`, not `retrieval_count`.
6. Sentiment aggregates from sums, and neutral maps to 50.
7. A brand alias change recomputes history and re-derives every other brand's position in affected chats.
8. An unsupported (channel, country) pair produces no chat row.
9. An unreadable source page reports "unknown", never "brand not mentioned".

---

## 19. Non-functional requirements

### 19.1 Performance

- Report endpoints: p95 < 800ms for 90-day windows on rollups; < 3s for raw-fact drill-downs.
- Dashboard first contentful paint < 1.5s; charts interactive < 2.5s on a seeded project.
- Enrichment throughput ≥ 200 chats/sec/worker for non-LLM steps; LLM steps batched and cached.
- Collection must finish a project's daily cycle within 6 hours of its offset.

### 19.2 Reliability

- Collection is idempotent per `job_key`; enrichment idempotent per `(chat_id, extractor_version)`.
- Raw captures retained ≥13 months so any extraction fix can be backfilled.
- Rollups rebuildable from facts by a single command; facts rebuildable from raw captures.
- Per-channel circuit breakers: a degraded channel is marked degraded in the UI rather than producing empty chats.

### 19.3 Observability

- Structured JSON logs with `project_id`, `chat_id`, `job_key`, `trace_id` on every line.
- Metrics: chats collected per channel/hour, enrichment lag, invariant-failure rate per parser, LLM spend per feature, queue depth, rollup watermark lag.
- Dashboards + alerts on: parser invariant failures >2%/15min, enrichment lag >30min, collection cycle overrun, LLM spend anomaly, quota exhaustion events.
- `x-trace-id` on every API response, echoed into support tooling.

### 19.4 Security and privacy

- Secrets in a managed secret store; nothing in env files in production. Customer-supplied third-party credentials (Cloudflare/Vercel/Akamai/GA tokens) encrypted at rest with envelope encryption and never logged.
- API keys hashed (argon2id); shown once; revocable; `last_used_at` tracked.
- Tenant isolation enforced in one query chokepoint plus a test matrix; cross-tenant reads return 404.
- `audit_log` for every configuration mutation, including actor, source (`web|api|mcp`), before/after.
- **GDPR posture** (the company is EU-based, so this is not optional): server-log ingest discards non-AI traffic *at ingest*, so visitor PII is never stored; `client_ip` in `agent_log` is bot IPs only and is truncated after 30 days; documented retention per data class; DSAR export and deletion endpoints; DPA-ready subprocessor list; EU data residency option for the primary datastore.
- Public share links: opaque high-entropy tokens, optional password, no mutation surface reachable, revocation invalidates permanently.
- **SOC 2 readiness** from the start: change management via PRs, access reviews, encrypted backups with restore drills, vendor register.

### 19.5 Cost control

The dominant costs are LLM calls in enrichment and (if built) `ui` collection infrastructure. Controls:

- Cache every LLM classification by content hash + template version.
- Route to the cheapest adequate model per task; sentiment and intent classification do not need a frontier model.
- Batch claim extraction per chat rather than per sentence.
- Skip re-fetching source pages within 14 days unless `content_hash` changed.
- Track spend per feature per project and alert on anomalies; a runaway Perception loop must not be discovered on the invoice.

---

## 20. Delivery plan

Each phase is independently demoable. Do not proceed until the definition of done passes.

### Phase 0 — Foundations
Monorepo, CI, lint/format, Postgres + Drizzle migrations, ClickHouse DDL (and the Postgres single-node path), auth, orgs/projects, RBAC, app shell with sidebar and filter bar.
**Done when:** a user can sign up, create an org and a project, and navigate an empty but complete shell.

### Phase 1 — Chats end to end (the spine)
Simulator adapter, scheduler, collect + enrich pipeline for brands/position/sentiment/sources/citations, `chat` and fact tables, rollups, brands report, Overview default layout, Chats list + chat detail, Prompts CRUD, Brands CRUD with alias/regex matching and historical recompute.
**Done when:** `pnpm seed` produces 90 days of data and the Overview shows correct visibility, SoV, position and sentiment that a hand calculation confirms. **This is the point at which the product exists.**

### Phase 2 — Sources
URL normalization, page fetching + markdown storage, domain/URL classification with overrides, domains and URLs reports, source pages, URL detail, Gap Analysis, bookmarks.
**Done when:** domain and URL metrics match the §8.2 fixtures and Gap Analysis surfaces real gaps in seeded data.

### Phase 3 — Organization and discovery
Topics, tags, tag groups, system branding/intent classification, prompt volume, bulk CSV, Prompt Discovery wizard with coverage, competitor suggestions, brand profile extraction.
**Done when:** a new project can be set up from a domain in under 10 minutes with a balanced prompt set.

### Phase 4 — Analysis surfaces
Brand Insights with performance matrix, Ranking, Fanouts, chat features, Ads, composable dashboard with widgets/views/sharing/PDF.
**Done when:** the matrix answers "which topics do I own on ChatGPT but not Perplexity" and a shared link renders read-only for a logged-out visitor.

### Phase 5 — Actions
Rules R1–R10, opportunity scoring, briefs grounded in evidence, lifecycle, Impact with markers.
**Done when:** every action displays the specific evidence rows that generated it, and completing one places a marker on Impact.

### Phase 6 — Real engines
`api` adapters for the major providers, model channel registry with version history, per-provider rate limiting, degraded-channel handling, `surface_kind` surfaced in the UI.
**Done when:** a project runs against ≥3 real providers and channel-level differences are visible.

### Phase 7 — Agent Analytics
Crawlability + URL tester, Crawl Insights with ≥3 ingestion paths (webhook, file upload, Cloudflare) and the joined visited-URLs table, AI Referrals with GA4 and the coverage-honesty callouts.
**Done when:** a blocked search bot in robots.txt produces a high-impact Action, and a crawled-but-never-cited URL is diagnosable.

### Phase 8 — Perception and Fact-checking
Probe generation, repetition, attribute extraction and clustering with editing, association vs market prominence, objections, facts/claims/verdicts and the three views.
**Done when:** the "biggest gap" card produces a defensible `#1 → #9` statement and a seeded wrong price appears as contradicted.

### Phase 9 — Shopping
Catalog ingest (Shopify, CSV, GMC), product matching, SKU metrics with win rate, attribute grid, merchants, demand queries, 30-day backfill on upload.
**Done when:** uploading a catalog immediately populates metrics from existing chats and price drift is visible.

### Phase 10 — Platform surfaces
Public REST API with keys/scopes/rate limits and generated OpenAPI, MCP server with read+write tools and slash commands, CSV exports, BI connector endpoint.
**Done when:** the dashboard, API and MCP return identical numbers for the same question, verified by a test that asserts it.

### Phase 11 — Commercial and hardening
Plans, credits, quota enforcement, agency pitch projects, pausing, billing, SSO, audit log, observability dashboards, load testing, GDPR endpoints.
**Done when:** quota limits are enforced everywhere and the load target in §19.1 is met.

### Phase 12 (optional, gated) — `ui` adapters
Only after §21.1 has been read and a decision recorded. Playwright pool, geo egress, per-channel parsers with versioning and invariant alarms, raw capture retention.
**Done when:** parser drift is detected and alarmed before it reaches customer dashboards.

---

## 21. Risks and legal considerations

### 21.1 Terms of service — read before building `ui` adapters

Automating the consumer web interfaces of ChatGPT, Gemini, Google AI Mode, Perplexity and Copilot at scale is, on the plain text of those providers' terms, generally **not permitted**: they variously prohibit automated access, circumventing rate limits or access controls, and scraping. Providers also actively deploy bot detection.

Consequences to weigh, and to record in an ADR before writing this code:

- **Contractual and legal exposure** for the operator, up to account termination and civil claims. In some jurisdictions circumventing technical access controls raises statutory issues beyond contract.
- **Reliability risk**: no SLA, no notice of change, and adversarial countermeasures. Expect recurring breakage.
- **Ethical/operational risk**: proxy networks used for geo egress vary enormously in provenance and consent quality. Vet suppliers.

Recommended posture:

1. **Default to `api` adapters.** Ship the product on official APIs and be explicit in the UI that these are API surfaces, labelled via `surface_kind`.
2. Where UI-fidelity data is genuinely required, prefer **licensed data partnerships** or providers that carry that risk contractually, rather than building the capability in-house.
3. If `ui` collection is nonetheless built: obtain legal review in every operating jurisdiction, keep volumes proportionate, honour `robots.txt` and rate limits for the *source pages* you fetch, never bypass paywalls or authentication, and document the decision and its rationale.
4. **Never misrepresent the collection method to customers.** The `surface_kind` field exists so the product cannot accidentally lie about where a number came from.

This spec is deliberately architected so that the entire product is valuable and shippable *without* `ui` adapters. That is the recommended path.

### 21.2 Product and technical risks

| Risk | Impact | Mitigation |
|---|---|---|
| Extraction bugs corrupt history | customers act on wrong data | raw capture retention + versioned extractors + backfill tooling (§3.3) |
| Silent empty chats from parser drift | reads as a real visibility collapse | invariant alarms + degraded-channel state, never write silent empties (§6.5) |
| LLM cost runaway | margin collapse | caching, cheap-model routing, per-feature spend alerts (§19.5) |
| Model non-determinism reads as signal | customers chase noise | default to 7-day windows, show confidence/variance, educate in-product that daily swings are expected |
| Metric drift between surfaces | trust loss | one query builder, one test asserting dashboard/API/MCP parity (Phase 10) |
| Engine coverage gaps misread as zero | wrong conclusions | explicit "not supported by this engine" states everywhere (§15.8, §15.9) |
| GA4 under-attribution read as total | executives conclude AI sends no traffic | mandatory floor-not-total callouts (§12.3) |
| Provider API deprecations | channel history fragments | model channels with version history (§5.3) |
| Multi-tenant leak | existential | single authz chokepoint + role×route test matrix (§18) |

### 21.3 Realistic effort characterization

Rather than calendar estimates, here is the technical shape of the work:

- **Phases 0–2** are the irreducible core: roughly 25 database tables, one collection pipeline, one extraction pipeline, one query builder, ~8 UI surfaces. A small team can build this coherently; it is mostly careful, well-specified work with two genuinely hard parts — brand matching accuracy and the metric semantics.
- **Phases 3–5** are breadth: many surfaces, each individually straightforward, plus one genuinely novel engine (Actions) whose difficulty is entirely in evidence quality rather than code.
- **Phases 6–9** each integrate an external system (LLM providers, CDNs/log providers, GA4, commerce feeds). The engineering is modest; the integration testing and error-path handling dominate.
- **Phase 10** is mechanical if §8 was implemented as a single shared builder, and painful if it was not. This is the strongest argument for getting §8 right first.
- **Phase 12** is open-ended and adversarial by nature — it is an ongoing operational commitment, not a project with an end.

The highest-risk dependencies are: keyword-volume data (Phase 3), LLM providers (Phases 1, 5, 8), and geo egress (Phase 12, optional).

---

## 22. Appendices

### 22.1 Appendix A — model channel seed

`description` is human-facing and may change; `id` is permanent. `supports_*` gates which extraction steps run and which UI sections render.

| channel_id | description | surface | current model | fanouts | ads | shopping |
|---|---|---|---|---|---|---|
| `sim-0` | Simulator (dev/demo) | simulator | `simulator-v1` | yes | yes | yes |
| `openai-0` | ChatGPT UI | ui | `chatgpt-ui` | yes | yes | yes |
| `openai-1` | ChatGPT API + web search | api | `gpt-web-search` | partial | no | no |
| `google-0` | Google AI Mode | ui | `google-ai-mode` | yes | yes | yes |
| `google-1` | Google AI Overviews | ui | `google-aio` | yes | yes | no |
| `google-2` | Gemini app | ui | `gemini-app` | yes | no | no |
| `google-3` | Gemini API + Search grounding | api | `gemini-grounded` | partial | no | no |
| `perplexity-0` | Perplexity UI | ui | `perplexity-ui` | yes | yes | yes |
| `perplexity-1` | Perplexity Agent API | api | provider-reported | partial | no | no |
| `microsoft-0` | Microsoft Copilot | ui | `copilot-ui` | yes | yes | yes |
| `anthropic-0` | Claude UI | ui | `claude-ui` | partial | no | no |
| `anthropic-1` | Claude API + web search | api | `claude-web-search` | partial | no | no |
| `xai-0` | Grok | ui | `grok-ui` | partial | no | no |
| `mistral-0` | Le Chat | ui | `lechat-ui` | no | no | no |
| `deepseek-0` | DeepSeek | api | `deepseek-chat` | no | no | no |

`unsupported_country_codes` must be populated per channel from the provider's actual availability; a prompt in an unsupported country produces **no chat** (§6.1).

### 22.2 Appendix B — AI bot registry (Crawlability + Crawl Insights)

`type`: `training` (corpus building), `search` (index for AI answers), `user_query` (fetches live on a user's request), `other`. **Categorization is best-effort from published vendor documentation and MUST be labelled as such in the UI.** Ship as `packages/registry/src/bots.ts` with a documented update process.

| vendor | user agent token | type |
|---|---|---|
| OpenAI | `GPTBot` | training |
| OpenAI | `OAI-SearchBot` | search |
| OpenAI | `ChatGPT-User` | user_query |
| Anthropic | `ClaudeBot` | training |
| Anthropic | `anthropic-ai` | training |
| Anthropic | `Claude-Web` | search |
| Anthropic | `Claude-User` | user_query |
| Anthropic | `Claude-SearchBot` | search |
| Google | `Googlebot` | search |
| Google | `Google-Extended` | training |
| Google | `GoogleOther` | other |
| Google | `Google-CloudVertexBot` | training |
| Google | `Google-NotebookLM` | user_query |
| Perplexity | `PerplexityBot` | search |
| Perplexity | `Perplexity-User` | user_query |
| Microsoft | `bingbot` | search |
| Microsoft | `BingPreview` | other |
| Microsoft | `msnbot` | search |
| Meta | `meta-externalagent` | training |
| Meta | `meta-externalfetcher` | user_query |
| Meta | `FacebookBot` | other |
| Apple | `Applebot` | search |
| Apple | `Applebot-Extended` | training |
| Amazon | `Amazonbot` | search |
| ByteDance | `Bytespider` | training |
| Common Crawl | `CCBot` | training |
| Cohere | `cohere-ai` | training |
| Cohere | `cohere-training-data-crawler` | training |
| Mistral | `MistralAI-User` | user_query |
| xAI | `xAI-Bot` | training |
| You.com | `YouBot` | search |
| Diffbot | `Diffbot` | training |
| Allen Institute | `AI2Bot` | training |
| Allen Institute | `Ai2Bot-Dolma` | training |
| Hive | `ImagesiftBot` | training |
| Huawei | `PetalBot` | search |
| Baidu | `Baiduspider` | search |
| Yandex | `YandexAdditional` | training |
| Yandex | `YandexAdditionalBot` | training |
| Naver | `Naverbot` | search |
| Timpi | `Timpibot` | training |
| Webz.io | `omgilibot` | training |
| Webz.io | `omgili` | training |
| Brightbot | `Brightbot` | training |
| Firecrawl | `FirecrawlAgent` | user_query |
| Phind | `PhindBot` | search |
| Liner | `LinerBot` | search |
| Seekr | `SeekrBot` | search |
| Panscient | `Panscient` | training |
| Sidetrade | `Sidetrade indexer bot` | training |

Matching rule: case-insensitive substring match on the raw UA, **longest matching token wins** (so `Applebot-Extended` is never mis-attributed to `Applebot`, and `Claude-SearchBot` never to `ClaudeBot`).

### 22.3 Appendix C — AI assistant referral registry

Used to classify GA4 sessions as AI-assistant traffic (union with GA4's own AI channel grouping). Ship as `packages/registry/src/assistants.ts`, keyed by hostname suffix with a display name and platform.

```
OpenAI          chatgpt.com, chat.openai.com, openai.com
Google          gemini.google.com, bard.google.com, aistudio.google.com,
                notebooklm.google.com, vertexaisearch.cloud.google.com
Microsoft       copilot.microsoft.com, bing.com/chat, edgeservices.bing.com,
                copilot.cloud.microsoft, m365.cloud.microsoft
Perplexity      perplexity.ai, www.perplexity.ai
Anthropic       claude.ai
Meta            meta.ai
xAI             grok.com, x.ai
Mistral         chat.mistral.ai
DeepSeek        chat.deepseek.com
Others          poe.com, you.com, phind.com, huggingface.co/chat, character.ai,
                duck.ai, search.brave.com (Leo), komo.ai, iask.ai, andisearch.com,
                liner.ai, exa.ai, kimi.moonshot.cn, doubao.com, tongyi.aliyun.com,
                yuanbao.tencent.com, chatglm.cn, arc.net (Arc Search), monica.im,
                genspark.ai, felo.ai, scira.ai
```

Also match `utm_source` values (`chatgpt`, `perplexity`, `copilot`, `gemini`, …) since some assistants append them instead of sending a referrer.

### 22.4 Appendix D — enum reference

```
project.status         ONBOARDING TRIAL TRIAL_ENDED CUSTOMER CUSTOMER_ENDED
                       PITCH PITCH_ENDED PAUSED API_PARTNER DELETED
chat.status            ok empty error blocked
surface_kind           ui api simulator
chat features          SHOPPING PRODUCT_COMPARISON AD MAP WEB_SEARCH IMAGE
prompt.branding        branded non-branded
prompt.intent_type     informational commercial transactional
domain classification  CORPORATE EDITORIAL INSTITUTIONAL REFERENCE UGC
                       COMPETITOR OWN RELATED OTHER
url classification     HOMEPAGE CATEGORY_PAGE PRODUCT_PAGE LISTICLE COMPARISON
                       PROFILE ALTERNATIVE DISCUSSION HOW_TO_GUIDE ARTICLE OTHER
fanout query_type      search shopping synthetic
action group           SITE_AUDIT OWNED EARNED
action source type     owned_pages editorial reference ugc
action status          NEW IN_PROGRESS DONE DECLINED DELETED
relative opportunity   1 (Low) 2 (Medium) 3 (High)   → UI bands: Very low … Very high
bot type               training search user_query other
perception run kind    market objections factcheck
claim verdict          contradicted supported
product source         CATALOG LLM
shopping attr tab      characteristics facts ratings
market_size            Neighborhood City State/Province National Continental Bloc Global
async job status       QUEUED RUNNING SUCCEEDED FAILED
batch reject reasons   not_found no_changes duplicate_id name_conflict parent_not_found
                       category_not_found brand_not_found invalid_move invalid_tag not_editable
report operators       in not_in has_all gt gte lt lte
dimensions             prompt_id topic_id tag_id model_id model_channel_id
                       country_code chat_id date week month
org roles              owner admin member guest
project roles          editor viewer
```

### 22.5 Appendix E — CSV contracts

**Prompt bulk upload** — no header required (a header row is detected and ignored), UTF-8, comma or semicolon delimited:

```
column 1  prompt text (required, ≤200 chars)
column 2  ISO 3166-1 alpha-2 country code (optional, defaults to project default)
column 3  topic name (optional, created if absent)
column 4+ one tag per column (optional, created if absent)
```

**Product catalog upload** — header required, comma delimited, UTF-8:

```
title (required) | brand (required) | description | price | currency (ISO 4217)
link | imageLink | category ("Home > Kitchen > Cookware", any depth)
```

Google Merchant Center feeds are accepted unmodified (CSV/TSV/JSON/XML). Uploads are additive; the category tree is drafted for review before commit (§11.1).

**Access log upload** — CSV with a header, or Common/Combined Log Format. Non-AI-bot rows are discarded at parse time.

### 22.6 Appendix F — environment variables

```
# core
DATABASE_URL=postgres://...
DATA_BACKEND=postgres|clickhouse
CLICKHOUSE_URL=  CLICKHOUSE_USER=  CLICKHOUSE_PASSWORD=
REDIS_URL=redis://...
OBJECT_STORE_ENDPOINT=  OBJECT_STORE_BUCKET=  OBJECT_STORE_KEY=  OBJECT_STORE_SECRET=
APP_URL=  API_URL=  AUTH_SECRET=

# collection (all optional; simulator needs none)
COLLECTION_MODE=simulator|api|mixed
SIMULATOR_SEED=peec-dev
OPENAI_API_KEY=  ANTHROPIC_API_KEY=  GOOGLE_API_KEY=
PERPLEXITY_API_KEY=  XAI_API_KEY=  MISTRAL_API_KEY=  DEEPSEEK_API_KEY=

# internal LLM tasks (sentiment, classification, briefs, perception)
LLM_PROVIDER=openai|anthropic|google
LLM_MODEL_CHEAP=  LLM_MODEL_SMART=  LLM_EMBEDDING_MODEL=

# integrations (optional)
KEYWORD_DATA_PROVIDER=none|dataforseo|semrush
DATAFORSEO_LOGIN=  DATAFORSEO_PASSWORD=
GOOGLE_OAUTH_CLIENT_ID=  GOOGLE_OAUTH_CLIENT_SECRET=

# ops
SENTRY_DSN=  OTEL_EXPORTER_OTLP_ENDPOINT=  POSTHOG_KEY=
```

**Hard requirement:** with only the `core` block plus `COLLECTION_MODE=simulator`, `pnpm install && pnpm db:migrate && pnpm seed && pnpm dev` MUST bring up a fully populated, fully navigable product. Every third-party integration is optional and degrades gracefully with an in-UI explanation of what is unavailable and why.

---

## 23. Definition of done for the whole build

The project is complete when all of the following are true:

1. A fresh clone with no credentials reaches a fully seeded, navigable product in one command sequence (§22.6).
2. Every metric in §8 is verified against hand-computed fixtures, and all nine correctness tests in §18 pass.
3. The dashboard, REST API and MCP server return **identical numbers** for the same question, asserted by an automated test.
4. Every UI surface in §15 has real copy plus empty, loading and error states, works on mobile, and supports dark mode.
5. Engine coverage gaps, unreadable sources, quota exhaustion and GA4 under-attribution all render as explicit explanations rather than zeros.
6. Actions cite the specific evidence rows that produced them, and completing one places a marker on Impact.
7. `surface_kind` is visible wherever collection method could change how a number should be read.
8. Cross-tenant access attempts return 404 across the full role × route matrix.
9. Raw captures are retained and a documented command backfills any extraction fix over a date range.
10. `docs/decisions/` records the choices this spec left open, including the §21.1 posture on UI collection.
