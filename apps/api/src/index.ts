import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import {
  clearAdapterCache,
  DEFAULT_API_CHANNELS,
  describeAdapterRuntime,
  getAdapter,
  getChannelHealth,
  listBuiltAdapters,
  listChannelHealth,
  loadRepoEnv,
} from "@geo/adapters";
import { buildOpenApiDocument } from "@geo/contracts";
import {
  AuthError,
  acceptCompetitor,
  activateDiscoveredPrompts,
  adsFromStore,
  appendAuditLog,
  assertKeyCanAccessProject,
  biBrandsFlat,
  billingWebhookWasProcessed,
  billingMode,
  bindPromptToAnalysisScope,
  brandInsightsFromStore,
  brandsReportCsv,
  brandsReportPayload,
  buildIdpRedirectUrl,
  buildSpMetadataXml,
  chatsReportCsv,
  checkApiFeature,
  checkBiFeature,
  checkCollect,
  checkDatabaseReadiness,
  checkMcpFeature,
  checkProjectRateLimit,
  checkPromptActivation,
  classifySampleReferral,
  clearSso,
  commercialSummary,
  competitorSuggestions,
  completeCheckout,
  completeOnboarding,
  configureSso,
  connectCloudflare,
  convertPitchToCustomer,
  crawlInsightsDashboard,
  createApiKey,
  createBrand,
  createCheckoutSession,
  createDb,
  createProjectForUser,
  createPrompt,
  createSharedView,
  createTopic,
  type Db,
  type DemoStore,
  type DomainClass,
  deleteBrand,
  enrichChatRows,
  factcheckReport,
  fanoutsFromStore,
  gdprDeleteProjectData,
  gdprExportProject,
  generateActionsForStore,
  getAction,
  getChatDetail,
  getCrawlability,
  getDemoStore,
  getOrCreateProfile,
  getSessionUser,
  getSharedView,
  handleBillingWebhook,
  hasDatabaseUrl,
  impactFromStore,
  importPromptsCsv,
  ingestCatalogCsv,
  ingestUploadedLogs,
  ingestWebhookLogs,
  listActions,
  listApiKeys,
  listAuditLog,
  listBrands,
  listOnboardingPlans,
  listPrompts,
  listPurchasablePlans,
  listTags,
  listTopics,
  listUserProjects,
  loadSharedView,
  loadProjectStore,
  login,
  loginWithEmail,
  logout,
  marketPerceptionReport,
  metricsFromStore,
  objectionsReport,
  overviewReportPayload,
  parseOverviewFilters,
  parseSamlResponseEmail,
  pauseProject,
  persistCommercialSideEffects,
  persistProjectStore,
  persistCollectionEvidence,
  closeDb,
  billingEventMetadata,
  type BillingEvent,
  emailConfigured,
  requestPasswordRecovery,
  completePasswordRecovery,
  getReportSchedule,
  saveReportSchedule,
  persistSharedView,
  prepareDomainAnalysis,
  promptObservedMetrics,
  referralsOverview,
  importReferralRows,
  recordBillingWebhookEvent,
  refreshRobotsTxt,
  rejectCompetitor,
  replaceProjectCollection,
  reportsFromStore,
  revokeApiKey,
  revokeSharedView,
  runDiscovery,
  runMigrations,
  runUrlTester,
  SUBPROCESSORS,
  saveBrandProfile,
  setDomainClassification,
  setEnabledChannels,
  setOrgPlan,
  shoppingAttributesReport,
  shoppingMerchantsReport,
  shoppingProductDetail,
  shoppingProductsReport,
  shoppingSummary,
  signup,
  toggleActionStep,
  toggleBookmark,
  transitionAction,
  unpauseProject,
  updateBrand,
  updateProjectSettings,
  updatePrompt,
  userCanAccessProject,
  verifyApiKey,
  verifyStripeWebhookSignature,
} from "@geo/db";
import { callMcpTool, listPlannedTools, listSlashCommands } from "@geo/mcp";
import { getChannel, listApiChannels, MODEL_CHANNELS } from "@geo/registry";
import {
  checkQueueReadiness,
  enqueueAnalyzeProject,
  getAnalyzeProjectJob,
  queueMode,
  resetInlineJobState,
  runProjectCollectAndApply,
  snapshotProjectCollect,
} from "@geo/worker";
import Fastify from "fastify";
import { promptIdentity } from "@geo/db";

/** Fast Analyze: three truthful API channels across a compact market sample. */
const ANALYZE_CHANNELS = [
  "openai-1",
  "perplexity-1",
  "google-3",
] as const;

type AnalyzeJob = {
  id: string;
  project_id: string;
  domain: string;
  brand_name: string;
  status: "queued" | "running" | "done" | "error";
  message?: string;
  prompts_activated?: number;
  collect?: {
    chats_written: number;
    run_date: string;
    mode: string;
    channels: string[];
  };
  started_at: string;
  finished_at?: string;
};

const analyzeJobs = new Map<string, AnalyzeJob>();

const COOKIE = "geo_session";
/** Public demo project id — unauthenticated reads allowed in memory/fixture CI. */
const DEMO_PROJECT_ID = "prj_demo";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ADMIN_ONLY_PATHS = [
  /\/api-keys(?:\/|$)/,
  /\/billing(?:\/|$)/,
  /\/channels\/enabled(?:\/|$)/,
  /\/convert-pitch(?:\/|$)/,
  /\/gdpr\/delete(?:\/|$)/,
  /\/pause(?:\/|$)/,
  /\/sso(?:\/|$)/,
  /\/unpause(?:\/|$)/,
];

type AuthWindow = { startedAt: number; count: number };
const authWindows = new Map<string, AuthWindow>();
const httpMetrics = {
  requests: 0,
  errors: 0,
  durationMs: 0,
  startedAt: Date.now(),
};

export function validateProductionConfiguration(
  env: Record<string, string | undefined> = process.env,
) {
  if (env.NODE_ENV !== "production") return;
  const required = ["DATABASE_URL", "REDIS_URL", "WEB_URL", "CORS_ORIGINS"];
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length) {
    throw new Error(`Missing production configuration: ${missing.join(", ")}`);
  }
  if (env.GEO_ADAPTER_MODE === "fixture") {
    throw new Error("GEO_ADAPTER_MODE=fixture is not allowed in production");
  }
}

function productionCorsOrigins(): true | string[] {
  if (process.env.NODE_ENV !== "production") return true;
  return (process.env.CORS_ORIGINS ?? process.env.WEB_URL ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function roleMayMutate(role: string, pathOnly: string): boolean {
  if (role === "viewer") return false;
  if (ADMIN_ONLY_PATHS.some((pattern) => pattern.test(pathOnly))) {
    return role === "owner" || role === "admin";
  }
  return role === "owner" || role === "admin" || role === "member";
}

async function resolveProjectStore(
  db: Db | null,
  projectId: string,
): Promise<DemoStore | null> {
  if (db) {
    const fromPg = await loadProjectStore(db, projectId);
    if (fromPg) return fromPg;
  }
  const demo = await getDemoStore();
  if (demo.project.id === projectId) return demo;
  return null;
}

/**
 * Authz chokepoint for /v1/projects/:projectId/*.
 * - No DB (memory): allow prj_demo only.
 * - With DB: require session + org membership, except unauthenticated prj_demo fallback.
 */
async function authorizeProject(
  db: Db | null,
  req: {
    cookies?: Record<string, string | undefined>;
    method?: string;
    url?: string;
  },
  reply: {
    code: (n: number) => { send: (b: unknown) => unknown };
  },
  projectId: string,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const pathOnly = (req.url ?? "").split("?")[0] ?? "";
  const mutating = !SAFE_METHODS.has(method);
  if (
    projectId === DEMO_PROJECT_ID &&
    mutating &&
    process.env.NODE_ENV === "production"
  ) {
    reply.code(403).send({
      error: "demo_read_only",
      message: "The public demo is read-only in production.",
    });
    return false;
  }

  if (!db) {
    if (projectId !== DEMO_PROJECT_ID) {
      reply.code(401).send({ error: "unauthorized" });
      return false;
    }
    return true;
  }

  const sessionUser = await getSessionUser(db, req.cookies?.[COOKIE]);
  if (sessionUser) {
    const access = await userCanAccessProject(db, sessionUser.userId, projectId);
    if (access.ok) {
      if (!mutating || roleMayMutate(access.role, pathOnly)) return true;
      reply.code(403).send({
        error: "insufficient_role",
        message: "Your project role cannot perform this action.",
      });
      return false;
    }
    if (projectId === DEMO_PROJECT_ID) return true;
    reply.code(403).send({ error: "forbidden" });
    return false;
  }

  if (projectId === DEMO_PROJECT_ID) return true;
  reply.code(401).send({ error: "unauthorized" });
  return false;
}

export async function buildServer(options?: { databaseUrl?: string }) {
  const app = Fastify({ logger: true });
  const corsOrigins = productionCorsOrigins();
  if (
    process.env.NODE_ENV === "production" &&
    typeof corsOrigins !== "boolean" &&
    corsOrigins.length === 0
  ) {
    throw new Error("CORS_ORIGINS or WEB_URL is required in production");
  }
  await app.register(cors, {
    origin: corsOrigins,
    credentials: true,
  });
  await app.register(cookie);

  // Stripe signs the exact request bytes. Preserve them before Fastify's JSON
  // parser runs so signature verification never relies on re-serialization.
  app.addHook("preParsing", async (req, _reply, payload) => {
    const pathOnly = (req.url ?? "").split("?")[0] ?? "";
    if (pathOnly !== "/v1/billing/webhook") return payload;
    const chunks: Buffer[] = [];
    for await (const chunk of payload) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks);
    (req as { rawBody?: string }).rawBody = raw.toString("utf8");
    return Readable.from(raw);
  });

  let db: Db | null = null;
  const url =
    options && "databaseUrl" in options
      ? options.databaseUrl
      : process.env.DATABASE_URL;
  if (url) {
    process.env.DATABASE_URL = url;
    await runMigrations(url);
    db = createDb(url);
    app.addHook("onClose", async () => { if (db) await closeDb(db); });
  }

  /** Authz chokepoint — all /v1/projects/:projectId/* routes. */
  app.addHook("preHandler", async (req, reply) => {
    const pathOnly = (req.url ?? "").split("?")[0] ?? "";
    const m = pathOnly.match(/^\/v1\/projects\/([^/]+)/);
    if (!m) return;
    const projectId = decodeURIComponent(m[1]!);
    const ok = await authorizeProject(db, req, reply, projectId);
    if (!ok) return;
  });

  app.addHook("preHandler", async (req, reply) => {
    const pathOnly = (req.url ?? "").split("?")[0] ?? "";
    if (
      process.env.NODE_ENV === "production" &&
      (pathOnly.startsWith("/v1/saml/") || pathOnly.includes("/sso"))
    ) {
      return reply.code(501).send({
        error: "verified_saml_not_configured",
        message:
          "SAML is disabled until signed assertions, issuer, audience, and expiry are cryptographically verified.",
      });
    }
  });

  app.addHook("onRequest", async (req, reply) => {
    (req as { metricsStartedAt?: number }).metricsStartedAt = Date.now();
    const incoming = req.headers["x-trace-id"];
    const traceId =
      typeof incoming === "string" && incoming.length > 0
        ? incoming
        : randomUUID();
    (req as { traceId?: string }).traceId = traceId;
    reply.header("x-trace-id", traceId);
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (process.env.NODE_ENV === "production") {
      reply.header(
        "strict-transport-security",
        "max-age=31536000; includeSubDomains",
      );
    }

    const pathOnly = (req.url ?? "").split("?")[0] ?? "";
    const hasSessionCookie = (req.headers.cookie ?? "")
      .split(";")
      .some((part) => part.trim().startsWith(`${COOKIE}=`));
    if (
      process.env.NODE_ENV === "production" &&
      hasSessionCookie &&
      !SAFE_METHODS.has(req.method.toUpperCase())
    ) {
      const origin = req.headers.origin;
      const allowed =
        typeof corsOrigins !== "boolean" &&
        typeof origin === "string" &&
        corsOrigins.includes(origin);
      if (!allowed) {
        return reply.code(403).send({ error: "invalid_request_origin" });
      }
    }

    if (req.method === "POST" && /^\/v1\/auth\/(login|signup|forgot-password|reset-password)$/.test(pathOnly)) {
      const now = Date.now();
      const key = `${req.ip}:${pathOnly}`;
      const current = authWindows.get(key);
      const window =
        !current || now - current.startedAt >= 15 * 60_000
          ? { startedAt: now, count: 0 }
          : current;
      window.count += 1;
      authWindows.set(key, window);
      reply.header("x-ratelimit-limit", "10");
      reply.header("x-ratelimit-remaining", String(Math.max(0, 10 - window.count)));
      if (window.count > 10) {
        reply.header(
          "retry-after",
          String(Math.max(1, Math.ceil((window.startedAt + 15 * 60_000 - now) / 1000))),
        );
        return reply.code(429).send({ error: "auth_rate_limited" });
      }
    }
  });

  app.addHook("onResponse", async (req, reply) => {
    httpMetrics.requests += 1;
    if (reply.statusCode >= 500) httpMetrics.errors += 1;
    httpMetrics.durationMs +=
      Date.now() - ((req as { metricsStartedAt?: number }).metricsStartedAt ?? Date.now());
  });

  app.get("/health", async () => ({
    ok: true,
    service: "api",
    backend: db ? "postgres" : "memory",
  }));

  app.get("/ready", async (_req, reply) => {
    const database = db ? await checkDatabaseReadiness(db) : false;
    const queue = queueMode() === "bullmq" ? await checkQueueReadiness() : false;
    const ready =
      process.env.NODE_ENV === "production"
        ? database && queue
        : db == null || database;
    return reply.code(ready ? 200 : 503).send({
      ready,
      database,
      queue,
      queue_mode: queueMode(),
    });
  });

  app.get("/metrics", async (req, reply) => {
    if (process.env.NODE_ENV === "production") {
      const token = process.env.OPS_TOKEN;
      if (!token || req.headers.authorization !== `Bearer ${token}`) {
        return reply.code(404).send({ error: "not_found" });
      }
    }
    reply.type("text/plain; version=0.0.4");
    return [
      "# TYPE geolens_http_requests_total counter",
      `geolens_http_requests_total ${httpMetrics.requests}`,
      "# TYPE geolens_http_errors_total counter",
      `geolens_http_errors_total ${httpMetrics.errors}`,
      "# TYPE geolens_http_request_duration_ms_total counter",
      `geolens_http_request_duration_ms_total ${httpMetrics.durationMs}`,
      "# TYPE geolens_process_uptime_seconds gauge",
      `geolens_process_uptime_seconds ${Math.floor((Date.now() - httpMetrics.startedAt) / 1000)}`,
      "",
    ].join("\n");
  });

  app.get("/v1/ops/metrics", async (req, reply) => {
    if (process.env.NODE_ENV === "production") {
      const token = process.env.OPS_TOKEN;
      if (!token) return reply.code(404).send({ error: "not_found" });
      if (req.headers.authorization !== `Bearer ${token}`) {
        return reply.code(401).send({ error: "unauthorized" });
      }
    }
    return {
      service: "api",
      queue_mode: queueMode(),
      billing_mode: billingMode(),
      ui_adapters: {
        enabled: false,
        decision: "docs/decisions/0009-defer-ui-adapters.md",
        surface_kinds_allowed: ["simulator", "api", "fixture"],
      },
      telemetry: {
        available: true,
        format: "prometheus",
        endpoint: "/metrics",
        scope: "per API instance",
      },
    };
  });

  app.post("/v1/auth/signup", async (req, reply) => {
    if (!db) {
      return reply
        .code(503)
        .send({ error: "postgres_required", message: "Set DATABASE_URL" });
    }
    const body = req.body as {
      email?: string;
      password?: string;
      name?: string;
      org_name?: string;
      project_name?: string;
    };
    try {
      const result = await signup(db, {
        email: body.email ?? "",
        password: body.password ?? "",
        name: body.name,
        orgName: body.org_name,
        projectName: body.project_name,
      });
      reply.setCookie(COOKIE, result.token, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 60 * 60 * 24 * 14,
      });
      return {
        user: result.user,
        organization: result.organization,
        project: result.project,
      };
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(400).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post("/v1/auth/login", async (req, reply) => {
    if (!db) {
      return reply.code(503).send({ error: "postgres_required" });
    }
    const body = req.body as { email?: string; password?: string };
    try {
      const result = await login(db, {
        email: body.email ?? "",
        password: body.password ?? "",
      });
      reply.setCookie(COOKIE, result.token, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 60 * 60 * 24 * 14,
      });
      return { user: result.user, project: result.project };
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(401).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post("/v1/auth/forgot-password", async (req, reply) => {
    if (!db || !emailConfigured()) return reply.code(503).send({ error: "recovery_unavailable", message: "Password recovery requires database and email configuration." });
    const body = (req.body ?? {}) as { email?: unknown };
    if (typeof body.email !== "string" || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return reply.code(400).send({ error: "invalid_email" });
    const started = Date.now();
    try {
      await requestPasswordRecovery(db, body.email);
    } catch {
      // Never reveal whether an account exists or log the token/email contents.
      req.log.error("Password recovery email delivery failed");
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 500 - (Date.now() - started))));
    return { message: "If an account exists, a password reset link will be sent." };
  });

  app.post("/v1/auth/reset-password", async (req, reply) => {
    if (!db) return reply.code(503).send({ error: "postgres_required" });
    const body = (req.body ?? {}) as { token?: unknown; password?: unknown };
    if (typeof body.token !== "string" || typeof body.password !== "string") return reply.code(400).send({ error: "invalid_request" });
    try {
      await completePasswordRecovery(db, body.token, body.password);
      reply.clearCookie(COOKIE, { path: "/" });
      return { message: "Password updated. Sign in again with your new password." };
    } catch (error) {
      if (error instanceof AuthError) return reply.code(400).send({ error: error.code, message: error.message });
      throw error;
    }
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    if (db) {
      await logout(db, req.cookies[COOKIE]);
    }
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/v1/auth/me", async (req, reply) => {
    if (!db) {
      return {
        backend: "memory",
        user: { id: "usr_demo", email: "demo@acme.example", name: "Demo Owner" },
        projects: [{ id: "prj_demo", name: "Acme CRM Visibility", status: "CUSTOMER" }],
      };
    }
    const sessionUser = await getSessionUser(db, req.cookies[COOKIE]);
    if (!sessionUser) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
    const projects = await listUserProjects(db, sessionUser.userId);
    return {
      backend: "postgres",
      user: {
        id: sessionUser.userId,
        email: sessionUser.email,
        name: sessionUser.name,
      },
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
      })),
    };
  });

  app.post("/v1/projects", async (req, reply) => {
    if (!db) {
      return reply.code(503).send({ error: "postgres_required" });
    }
    const sessionUser = await getSessionUser(db, req.cookies[COOKIE]);
    if (!sessionUser) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
    const body = req.body as { name?: string; domain?: string };
    if (!body.name?.trim()) {
      return reply.code(400).send({ error: "name_required" });
    }
    try {
      const created = await createProjectForUser(db, sessionUser.userId, {
        name: body.name.trim(),
        domain: body.domain,
      });
      return { project: created };
    } catch (err) {
      if (err instanceof AuthError) {
        const code =
          err.code === "project_quota" || err.code === "forbidden"
            ? err.code === "project_quota"
              ? 409
              : 403
            : 403;
        return reply
          .code(code)
          .send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.get("/v1/projects/:projectId", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    return {
      project: store.project,
      organization: store.organization,
      brands: store.brands,
      prompts: store.prompts,
    };
  });

  app.patch("/v1/projects/:projectId", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const body = (req.body ?? {}) as {
      name?: string;
      domain?: string;
      location?: string;
      language?: string;
      timezone?: string;
      default_country?: string;
    };
    const project = updateProjectSettings(store, body);
    // Keep brand profile domain/name in sync when project URL/name changes.
    if (body.domain || body.name) {
      const profile = getOrCreateProfile(store);
      saveBrandProfile(store, {
        ...(body.domain ? { domain: project.domain ?? profile.domain } : {}),
        ...(body.name && !profile.reviewed ? { name: project.name } : {}),
      });
      if (body.domain && project.domain) {
        const own = store.brands.find((b) => b.is_own);
        if (own && !own.name) {
          /* no-op */
        }
      }
    }
    await persistProjectStore(db, store);
    await persistCommercialSideEffects(db, store);
    return { project };
  });

  /**
   * Semrush-style “enter website → Analyze”:
   * bind domain to this project (brand profile + own brand) and return project id for overview.
   * Body: { domain: string, create?: boolean }
   * - create=true + authenticated Postgres: new project, then analyze
   * - otherwise: update the current project
   */
  app.post("/v1/projects/:projectId/analyze", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = (req.body ?? {}) as { domain?: string; create?: boolean };
    const raw = body.domain?.trim() ?? "";
    if (!raw) {
      return reply.code(400).send({
        error: "domain_required",
        message: "Enter a website domain to analyze.",
      });
    }

    let targetId = projectId;

    if (body.create) {
      if (!db) {
        return reply.code(503).send({
          error: "postgres_required",
          message: "Sign in with a Postgres-backed account to create a new project.",
        });
      }
      const sessionUser = await getSessionUser(db, req.cookies[COOKIE]);
      if (!sessionUser) {
        return reply.code(401).send({
          error: "unauthenticated",
          message: "Sign in to analyze a new website as a separate project.",
        });
      }
      try {
        const created = await createProjectForUser(db, sessionUser.userId, {
          name: "New project",
          domain: raw,
        });
        targetId = created.id;
      } catch (err) {
        if (err instanceof AuthError) {
          const code = err.code === "project_quota" ? 409 : 403;
          return reply
            .code(code)
            .send({ error: err.code, message: err.message });
        }
        throw err;
      }
    }

    const store = await resolveProjectStore(db, targetId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });

    try {
      const prepared = prepareDomainAnalysis(store, raw, { prompt_limit: 8 });
      const gate = checkCollect(store);
      if (!gate.ok) {
        await persistProjectStore(db, store);
        await persistCommercialSideEffects(db, store);
        return reply.code(409).send({
          error: gate.code,
          message: gate.message,
          project_id: store.project.id,
          domain: prepared.domain,
          brand_name: prepared.brand_name,
        });
      }

      // Persist prepared domain/prompts immediately so Overview shows the new brand
      // while collection runs in the background (avoids Next /backend proxy timeouts).
      if (db) {
        await replaceProjectCollection(db, store);
        await persistCommercialSideEffects(db, store);
      } else {
        await persistProjectStore(db, store);
      }

      const jobId = `aj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const job: AnalyzeJob = {
        id: jobId,
        project_id: store.project.id,
        domain: prepared.domain,
        brand_name: prepared.brand_name,
        status: "running",
        prompts_activated: prepared.prompts_activated,
        started_at: new Date().toISOString(),
      };
      analyzeJobs.set(jobId, job);

      const projectRef = store.project.id;
      const snapshot = snapshotProjectCollect(store, { channelIds: [...ANALYZE_CHANNELS], observationId: jobId, runDate: new Date().toISOString().slice(0, 10), seed: `analyze|${prepared.domain}|${jobId}` });
      if (queueMode() === "bullmq" && db) {
        job.status = "queued";
        await enqueueAnalyzeProject({
          job_id: jobId,
          project_id: projectRef,
          domain: prepared.domain,
          brand_name: prepared.brand_name,
          prompts_activated: prepared.prompts_activated,
          channel_ids: [...ANALYZE_CHANNELS],
          concurrency: 2,
          seed: `analyze|${prepared.domain}|${Date.now()}`,
          run_date: new Date().toISOString().slice(0, 10),
          started_at: job.started_at,
          snapshot,
        });
      } else void (async () => {
        try {
          const live = await resolveProjectStore(db, projectRef);
          if (!live) throw new Error("project_not_found");
          resetInlineJobState();
          const collect = await runProjectCollectAndApply(live, {
            observationId: job.id,
            snapshot,
            forceInline: true,
            channelIds: [...ANALYZE_CHANNELS],
            concurrency: 2,
            seed: `analyze|${prepared.domain}|${Date.now()}`,
            runDate: new Date().toISOString().slice(0, 10),
          });
          if (db) {
            await persistCollectionEvidence(db, live);
          } else {
            await persistProjectStore(db, live);
          }
          job.status = collect.eligible_answers > 0 ? "done" : "error";
          if (collect.eligible_answers === 0) job.message = "No eligible answers were collected. Review channel errors, restore provider access, and run a new analysis.";
          else if (collect.failed_attempts > 0) job.message = `Collected ${collect.eligible_answers} eligible answers; ${collect.failed_attempts} attempts failed. Results describe the successful sample.`;
          job.collect = {
            chats_written: collect.chats_written,
            run_date: collect.run_date,
            mode: collect.mode,
            channels: [...ANALYZE_CHANNELS],
          };
          job.finished_at = new Date().toISOString();
        } catch (err) {
          job.status = "error";
          job.message =
            err instanceof Error ? err.message : "Collection failed";
          job.finished_at = new Date().toISOString();
        }
      })();

      const runtime = describeAdapterRuntime();
      return reply.code(202).send({
        status: job.status,
        job_id: jobId,
        project_id: store.project.id,
        domain: prepared.domain,
        brand_name: prepared.brand_name,
        project: prepared.project,
        created: body.create === true && targetId !== projectId,
        prompts_activated: prepared.prompts_activated,
        runtime: {
          collection_backend: runtime.GEO_COLLECTION_BACKEND,
          cursor_key_present: runtime.cursor_key_present,
          openrouter_key_present: runtime.openrouter_key_present,
          global_resolved: runtime.global_resolved,
        },
        note: "Collection runs in the background — poll GET …/analyze/jobs/:jobId",
      });
    } catch (err) {
      const code =
        err instanceof Error && (err as Error & { code?: string }).code
          ? (err as Error & { code?: string }).code
          : "invalid_domain";
      return reply.code(400).send({
        error: code,
        message:
          err instanceof Error ? err.message : "Enter a valid website domain.",
      });
    }
  });

  app.get("/v1/projects/:projectId/analyze/jobs/:jobId", async (req, reply) => {
    const { projectId, jobId } = req.params as {
      projectId: string;
      jobId: string;
    };
    const durable = await getAnalyzeProjectJob(jobId);
    if (durable.found && durable.payload?.project_id === projectId) {
      const store = await resolveProjectStore(db, projectId);
      return {
        id: jobId,
        project_id: projectId,
        domain: durable.payload.domain,
        brand_name: durable.payload.brand_name,
        prompts_activated: durable.payload.prompts_activated,
        status: durable.status,
        message: durable.message,
        collect: durable.result
          ? {
              chats_written: durable.result.chats_written,
              run_date: durable.result.run_date,
              mode: durable.result.mode,
              channels: durable.result.channels,
            }
          : undefined,
        started_at: durable.payload.started_at,
        finished_at: durable.result?.finished_at,
        chats: store?.chats.length ?? 0,
        overview:
          durable.status === "done" && store
            ? overviewReportPayload(store)
            : undefined,
      };
    }
    const job = analyzeJobs.get(jobId);
    if (!job || job.project_id !== projectId) {
      return reply.code(404).send({ error: "job_not_found" });
    }
    const store = await resolveProjectStore(db, projectId);
    return {
      ...job,
      chats: store?.chats.length ?? 0,
      overview:
        job.status === "done" && store
          ? overviewReportPayload(store)
          : undefined,
    };
  });

  app.post("/v1/projects/:projectId/onboarding/complete", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const body = (req.body ?? {}) as {
      plan_code?: string;
      billing_period?: "monthly" | "annual";
      keep_trial?: boolean;
    };
    const paidPlanRequested =
      Boolean(body.plan_code) && body.plan_code !== "trial" && !body.keep_trial;
    const project = completeOnboarding(store, {
      plan_code: body.plan_code,
      billing_period: body.billing_period,
      // A production onboarding click cannot grant a paid plan. Stripe's
      // signed checkout webhook is the only path that applies it.
      keep_trial:
        process.env.NODE_ENV === "production" && paidPlanRequested
          ? true
          : body.keep_trial ?? (!body.plan_code || body.plan_code === "trial"),
      source: "api",
    });
    await persistProjectStore(db, store);
    await persistCommercialSideEffects(db, store);
    return {
      project,
      organization: store.organization,
      billing: commercialSummary(store),
    };
  });

  app.get("/v1/projects/:projectId/onboarding/plans", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const q = req.query as { billing_period?: string };
    const period =
      q.billing_period === "annual" || q.billing_period === "yearly"
        ? "annual"
        : "monthly";
    return {
      billing_period: period,
      plans: listOnboardingPlans(period),
      current: {
        plan_code: store.organization.plan_code,
        billing_period: store.organization.billing_period,
        project_status: store.project.status,
      },
    };
  });

  app.get("/v1/projects/:projectId/report-schedule", async (req, reply) => {
    if (!db) return reply.code(503).send({ error: "postgres_required" });
    const user = await getSessionUser(db, req.cookies[COOKIE]);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const { projectId } = req.params as { projectId: string };
    return { schedule: await getReportSchedule(db, projectId, user.userId), recipient: user.email, delivery_configured: emailConfigured() };
  });

  app.put("/v1/projects/:projectId/report-schedule", async (req, reply) => {
    if (!db) return reply.code(503).send({ error: "postgres_required" });
    const user = await getSessionUser(db, req.cookies[COOKIE]);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const { projectId } = req.params as { projectId: string };
    const body = (req.body ?? {}) as { frequency?: unknown; enabled?: unknown };
    if ((body.frequency !== "daily" && body.frequency !== "weekly") || typeof body.enabled !== "boolean") return reply.code(400).send({ error: "invalid_schedule" });
    if (body.enabled && !emailConfigured()) return reply.code(503).send({ error: "email_not_configured", message: "Configure SMTP before enabling email reports." });
    return { schedule: await saveReportSchedule(db, { projectId, userId: user.userId, frequency: body.frequency, enabled: body.enabled }) };
  });

  app.get("/v1/projects/:projectId/reports/brands", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const report = brandsReportPayload(store);
    return {
      ...report,
      meta: {
        ...report.meta,
        channels: [...new Set(store.chats.map((c) => c.model_channel_id))],
        surface_kinds: [
          ...new Set(
            store.chats
              .map((c) => c.surface_kind)
              .filter(
                (s): s is "ui" | "api" | "simulator" =>
                  s === "ui" || s === "api" || s === "simulator",
              ),
          ),
        ],
        backend: db ? "postgres" : "memory",
        geo_note:
          "API channels have geo=none — country_code is the requested market, not true localization.",
      },
    };
  });

  app.get("/v1/projects/:projectId/reports/overview", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const q = req.query as { range?: string; channel?: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const filters = parseOverviewFilters({
      range: q.range,
      channel: q.channel,
    });
    return overviewReportPayload(store, filters);
  });

  app.get("/v1/channels", async () => {
    const health = Object.fromEntries(
      listChannelHealth().map((h) => [h.channelId, h]),
    );
    const runtime = describeAdapterRuntime();
    const modeByChannel = Object.fromEntries(
      runtime.channels.map((c) => [c.channel_id, c]),
    );
    return {
      rows: MODEL_CHANNELS.map((c) => {
        const collection = modeByChannel[c.id] ?? null;
        return {
          ...c,
          description: collection?.route_note ?? c.description,
          health: health[c.id] ?? getChannelHealth(c.id),
          has_adapter: (() => {
            try {
              getAdapter(c.id);
              return true;
            } catch {
              return false;
            }
          })(),
          adapter_mode: collection?.mode ?? null,
          key_present: collection?.key_present ?? false,
          collection,
        };
      }),
      api_default: [...DEFAULT_API_CHANNELS],
      runtime,
      note: "surface_kind must be shown whenever collection method could change how a number is read.",
    };
  });

  app.get("/v1/adapters/runtime", async () => describeAdapterRuntime());

  app.get("/v1/channels/:channelId/health", async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    const ch = getChannel(channelId);
    if (!ch) return reply.code(404).send({ error: "channel_not_found" });
    let adapterHealth: { ok: boolean; detail: string } = {
      ok: false,
      detail: "no_adapter",
    };
    let adapterInstance: ReturnType<typeof getAdapter> | undefined;
    try {
      adapterInstance = getAdapter(channelId);
      const h = await adapterInstance.health();
      adapterHealth = { ok: h.ok, detail: h.detail ?? (h.ok ? "ok" : "error") };
    } catch {
      /* channel without adapter */
    }
    const runtimeChannel = describeAdapterRuntime().channels.find(
      (row) => row.channel_id === channelId,
    );
    return {
      channel: {
        ...ch,
        description: runtimeChannel?.route_note ?? ch.description,
        supportsFanouts: adapterInstance?.capabilities.fanouts ?? ch.supportsFanouts,
        supportsAds: adapterInstance?.capabilities.ads ?? ch.supportsAds,
        supportsShopping:
          adapterInstance?.capabilities.shopping ?? ch.supportsShopping,
      },
      collection: runtimeChannel ?? null,
      health: getChannelHealth(channelId),
      adapter: adapterHealth,
    };
  });

  app.get("/v1/projects/:projectId/reports/channels", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const own = store.brands.find((b) => b.is_own);
    const runtimeByChannel = Object.fromEntries(
      describeAdapterRuntime().channels.map((row) => [row.channel_id, row]),
    );
    const byChannel = new Map<
      string,
      { chats: number; ok: number; mentioned: number; surface_kind?: string }
    >();
    for (const c of store.chats) {
      const cur = byChannel.get(c.model_channel_id) ?? {
        chats: 0,
        ok: 0,
        mentioned: 0,
        surface_kind: c.surface_kind,
      };
      cur.chats += 1;
      if (c.status === "ok" || c.status === "empty") cur.ok += 1;
      byChannel.set(c.model_channel_id, cur);
    }
    if (own) {
      for (const m of store.mentions) {
        if (m.brand_id !== own.id) continue;
        const chat = store.chats.find((c) => c.id === m.chat_id);
        if (!chat) continue;
        const cur = byChannel.get(chat.model_channel_id);
        if (cur) cur.mentioned += 1;
      }
    }
    const rows = [...byChannel.entries()].map(([channel_id, v]) => {
      const meta = getChannel(channel_id);
      const collection = runtimeByChannel[channel_id] ?? null;
      const observations = store.chats.filter((chat) => chat.model_channel_id === channel_id);
      const latestDate = observations.map((chat) => chat.run_date).sort().at(-1);
      const latest = observations.filter((chat) => chat.run_date === latestDate);
      const failures = latest.filter((chat) => chat.status === "error" || chat.status === "blocked").length;
      const stale = latestDate ? Date.now() - Date.parse(`${latestDate}T00:00:00Z`) > 2 * 86400_000 : true;
      const persistedHealth = {
        status: failures === latest.length ? "down" : failures > 0 ? "degraded" : stale ? "stale" : "ok",
        reason: `Latest observed day: ${latestDate ?? "none"}; ${latest.length - failures}/${latest.length} eligible answers.`,
      };
      return {
        channel_id,
        description: collection?.route_note ?? meta?.description ?? channel_id,
        surface_kind: v.surface_kind ?? meta?.surface ?? "unknown",
        geo_capability: meta?.geoCapability ?? "none",
        chat_count: v.chats,
        visibility: v.ok === 0 ? 0 : v.mentioned / v.ok,
        health: persistedHealth,
        version_history: meta?.versionHistory ?? [],
        collection,
      };
    });
    return {
      rows,
      providers: listApiChannels().map((c) => c.provider),
      adapters_ready: listBuiltAdapters().map((a) => a.channelId),
    };
  });

  app.get("/v1/projects/:projectId/chats", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const query = req.query as { limit?: string };
    const limit = Math.min(Number(query.limit ?? 50), 200);
    const rows = enrichChatRows(store, limit);
    return { rows, total: store.chats.length };
  });

  app.get("/v1/projects/:projectId/chats/:chatId", async (req, reply) => {
    const { projectId, chatId } = req.params as {
      projectId: string;
      chatId: string;
    };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const detail = await getChatDetail(store, chatId);
    if (!detail) return reply.code(404).send({ error: "chat_not_found" });
    return detail;
  });

  app.get("/v1/projects/:projectId/prompts", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const rows = (await listPrompts(db, projectId)) ?? store.prompts;
    return { rows, metrics: promptObservedMetrics(store) };
  });

  app.post("/v1/projects/:projectId/prompts", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const body = req.body as {
      text?: string;
      country_code?: string;
      status?: "active" | "paused" | "archived";
    };
    const status = body.status ?? "active";
    const duplicate = status === "active" && store.prompts.find((p) => p.status === "active" &&
      promptIdentity(p.text, p.country_code) === promptIdentity(body.text ?? "", body.country_code ?? "US"));
    if (duplicate) return { prompt: duplicate };
    if (status === "active") {
      const q = checkPromptActivation(store, 1);
      if (!q.ok) {
        return reply.code(409).send({ error: q.code, message: q.message });
      }
    }
    try {
      const row = await createPrompt(db, projectId, {
        text: body.text ?? "",
        country_code: body.country_code,
        status,
      });
      if (!row) return reply.code(404).send({ error: "project_not_found" });
      if (!store.prompts.some((p) => p.id === row.id)) {
        store.prompts.push(row);
      }
      if (row.status === "active") bindPromptToAnalysisScope(store, row.id);
      appendAuditLog(store, {
        source: "api",
        action: "prompt.create",
        project_id: projectId,
        after: row,
      });
      await persistProjectStore(db, store);
      return { prompt: row };
    } catch (err) {
      if ((err as { code?: string }).code === "23505" || (err as { cause?: { code?: string } }).cause?.code === "23505") {
        return reply.code(409).send({ error: "active_prompt_already_exists" });
      }
      if (err instanceof Error && err.message === "text_required") {
        return reply.code(400).send({ error: "text_required" });
      }
      throw err;
    }
  });

  app.patch("/v1/projects/:projectId/prompts/:promptId", async (req, reply) => {
    const { projectId, promptId } = req.params as {
      projectId: string;
      promptId: string;
    };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const body = req.body as {
      text?: string;
      country_code?: string;
      status?: "active" | "paused" | "archived";
    };
    const existing = store.prompts.find((p) => p.id === promptId);
    if (
      body.status === "active" &&
      existing &&
      existing.status !== "active"
    ) {
      const q = checkPromptActivation(store, 1);
      if (!q.ok) {
        return reply.code(409).send({ error: q.code, message: q.message });
      }
    }
    const before = existing ? { ...existing } : undefined;
    if (body.text !== undefined && (typeof body.text !== "string" || !body.text.trim())) {
      return reply.code(400).send({ error: "text_required" });
    }
    let row: Awaited<ReturnType<typeof updatePrompt>>;
    try {
      row = await updatePrompt(db, projectId, promptId, body);
    } catch (err) {
      if ((err instanceof Error && err.message === "active_prompt_already_exists") ||
        (err as { code?: string }).code === "23505" || (err as { cause?: { code?: string } }).cause?.code === "23505") {
        return reply.code(409).send({ error: "active_prompt_already_exists" });
      }
      throw err;
    }
    if (!row) return reply.code(404).send({ error: "prompt_not_found" });
    if (row.id !== promptId) {
      if (existing) existing.status = "archived";
      if (!store.prompts.some((prompt) => prompt.id === row.id)) {
        store.prompts.push({ ...existing, ...row });
      }
    } else if (existing) Object.assign(existing, row);
    if (row.status === "active") {
      bindPromptToAnalysisScope(store, row.id, row.id !== promptId ? promptId : undefined);
    }
    appendAuditLog(store, {
      source: "api",
      action: "prompt.update",
      project_id: projectId,
      before,
      after: row,
    });
    await persistProjectStore(db, store);
    return { prompt: row };
  });

  app.get("/v1/projects/:projectId/reports/domains", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const { domains } = reportsFromStore(store);
    return {
      project_id: projectId,
      formula: {
        retrieved_percentage: "retrieved_chat_count / total_chat_count",
        retrieval_rate: "retrieval_count / total_chat_count",
        citation_rate: "citation_count / retrieved_chat_count",
        citation_share: "citation_count / sum(citation_count)",
      },
      rows: domains,
    };
  });

  app.get("/v1/projects/:projectId/reports/urls", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const { urls } = reportsFromStore(store);
    return {
      project_id: projectId,
      formula: {
        retrieval_count: "distinct chats retrieving the URL",
        citation_rate: "citation_count / retrieval_count",
      },
      rows: urls,
    };
  });

  app.get("/v1/projects/:projectId/reports/gaps", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const { domainGaps, urlGaps } = reportsFromStore(store);
    return {
      project_id: projectId,
      domains: domainGaps,
      urls: urlGaps,
    };
  });

  app.patch(
    "/v1/projects/:projectId/sources/domains/:domain/classification",
    async (req, reply) => {
      const { projectId, domain } = req.params as {
        projectId: string;
        domain: string;
      };
      const store = await resolveProjectStore(db, projectId);
      if (!store) return reply.code(404).send({ error: "project_not_found" });
      const body = req.body as { classification?: DomainClass | null };
      const decoded = decodeURIComponent(domain);
      setDomainClassification(
        store,
        decoded,
        body.classification === undefined ? null : body.classification,
      );
      await persistProjectStore(db, store);
      const { domains } = reportsFromStore(store);
      return { domain: domains.find((d) => d.domain === decoded) ?? null };
    },
  );

  app.post("/v1/projects/:projectId/sources/bookmarks", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const body = req.body as { key?: string };
    if (!body.key) return reply.code(400).send({ error: "key_required" });
    const bookmarked = toggleBookmark(store, body.key);
    await persistProjectStore(db, store);
    return { key: body.key, bookmarked };
  });

  app.get("/v1/projects/:projectId/topics", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    return { rows: listTopics(store), tags: listTags(store) };
  });

  app.post("/v1/projects/:projectId/topics", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const body = req.body as { name?: string };
    if (!body.name?.trim()) return reply.code(400).send({ error: "name_required" });
    const topic = createTopic(store, body.name);
    await persistProjectStore(db, store);
    return { topic };
  });

  app.get("/v1/projects/:projectId/brand-profile", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    return { profile: getOrCreateProfile(store) };
  });

  app.patch("/v1/projects/:projectId/brand-profile", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const body = req.body as Record<string, unknown>;
    const profile = saveBrandProfile(store, {
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.industry === "string" ? { industry: body.industry } : {}),
      ...(typeof body.tagline === "string" ? { tagline: body.tagline } : {}),
      ...(typeof body.description === "string"
        ? { description: body.description }
        : {}),
      ...(Array.isArray(body.identityTags)
        ? { identityTags: body.identityTags as string[] }
        : Array.isArray(body.identity_tags)
          ? { identityTags: body.identity_tags as string[] }
          : {}),
      ...(Array.isArray(body.targetMarkets)
        ? { targetMarkets: body.targetMarkets as string[] }
        : Array.isArray(body.target_markets)
          ? { targetMarkets: body.target_markets as string[] }
          : {}),
      ...(Array.isArray(body.products)
        ? { products: body.products as string[] }
        : {}),
      ...(Array.isArray(body.personas)
        ? { personas: body.personas as string[] }
        : {}),
      ...(typeof body.reviewed === "boolean" ? { reviewed: body.reviewed } : {}),
      ...(typeof body.domain === "string" ? { domain: body.domain } : {}),
    });
    await persistProjectStore(db, store);
    return { profile };
  });

  app.get("/v1/projects/:projectId/competitors/suggestions", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    return { rows: competitorSuggestions(store) };
  });

  app.post("/v1/projects/:projectId/competitors/suggestions/:name/accept", async (req, reply) => {
    const { projectId, name } = req.params as { projectId: string; name: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const brand = acceptCompetitor(store, decodeURIComponent(name));
    await persistProjectStore(db, store);
    return { brand };
  });

  app.post("/v1/projects/:projectId/competitors/suggestions/:name/reject", async (req, reply) => {
    const { projectId, name } = req.params as { projectId: string; name: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    rejectCompetitor(store, decodeURIComponent(name));
    await persistProjectStore(db, store);
    return { ok: true };
  });

  app.get("/v1/projects/:projectId/brands", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    return { rows: listBrands(store) };
  });

  app.post("/v1/projects/:projectId/brands", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const body = (req.body as {
      name?: string;
      is_own?: boolean;
      aliases?: string[];
      patterns?: string[];
    }) ?? {};
    try {
      const brand = createBrand(store, {
        name: body.name ?? "",
        is_own: body.is_own,
        aliases: body.aliases,
        patterns: body.patterns,
      });
      await persistProjectStore(db, store);
      return reply.code(201).send({ brand });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "brand_error";
      return reply
        .code(msg === "brand_name_exists" ? 409 : 400)
        .send({ error: msg });
    }
  });

  app.patch("/v1/projects/:projectId/brands/:brandId", async (req, reply) => {
    const { projectId, brandId } = req.params as {
      projectId: string;
      brandId: string;
    };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const body = (req.body as {
      name?: string;
      is_own?: boolean;
      aliases?: string[];
      patterns?: string[];
    }) ?? {};
    try {
      const brand = updateBrand(store, brandId, body);
      if (!brand) return reply.code(404).send({ error: "brand_not_found" });
      await persistProjectStore(db, store);
      return { brand };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "brand_error";
      return reply
        .code(msg === "brand_name_exists" ? 409 : 400)
        .send({ error: msg });
    }
  });

  app.delete("/v1/projects/:projectId/brands/:brandId", async (req, reply) => {
    const { projectId, brandId } = req.params as {
      projectId: string;
      brandId: string;
    };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const ok = deleteBrand(store, brandId);
    if (!ok) return reply.code(404).send({ error: "brand_not_found" });
    await persistProjectStore(db, store);
    return { ok: true };
  });

  app.post("/v1/projects/:projectId/discovery/generate", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const body = req.body as {
      countries?: string[];
      topics?: string[];
      branded_share?: number;
    };
    const result = runDiscovery(store, {
      countries: body.countries,
      topics: body.topics,
      brandedShare: body.branded_share,
    });
    return result;
  });

  app.post("/v1/projects/:projectId/discovery/activate", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const body = req.body as { prompts?: Parameters<typeof activateDiscoveredPrompts>[1] };
    const n = body.prompts?.length ?? 0;
    if (n > 0) {
      const q = checkPromptActivation(store, n);
      if (!q.ok) {
        return reply.code(409).send({ error: q.code, message: q.message });
      }
    }
    const created = activateDiscoveredPrompts(store, body.prompts ?? []);
    appendAuditLog(store, {
      source: "api",
      action: "discovery.activate",
      project_id: projectId,
      after: { count: created.length },
    });
    await persistProjectStore(db, store);
    return { created, count: created.length };
  });

  app.post("/v1/projects/:projectId/prompts/import", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const body = req.body as { csv?: string };
    if (!body.csv) return reply.code(400).send({ error: "csv_required" });
    const lines = body.csv.split(/\r?\n/).filter((l) => l.trim()).length;
    const q = checkPromptActivation(store, Math.max(1, lines - 1));
    if (!q.ok) {
      return reply.code(409).send({ error: q.code, message: q.message });
    }
    const created = importPromptsCsv(store, body.csv);
    appendAuditLog(store, {
      source: "api",
      action: "prompts.import",
      project_id: projectId,
      after: { count: created.length },
    });
    await persistProjectStore(db, store);
    return { created, count: created.length };
  });

  app.get("/v1/projects/:projectId/insights/brand", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const q = req.query as {
      brand_id?: string;
      row_axis?: "topic" | "channel" | "country" | "brand";
      col_axis?: "topic" | "channel" | "country" | "brand";
    };
    return brandInsightsFromStore(store, q.brand_id, {
      rowAxis: q.row_axis,
      colAxis: q.col_axis,
    });
  });

  app.get("/v1/projects/:projectId/reports/fanouts", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    return fanoutsFromStore(store);
  });

  app.get("/v1/projects/:projectId/reports/ads", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    return adsFromStore(store);
  });

  app.post("/v1/projects/:projectId/views", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const body = req.body as {
      name?: string;
      widgets?: string[];
      expires_in_days?: number;
    };
    const view = createSharedView(store, {
      name: body.name ?? "Shared overview",
      widgets: body.widgets,
      expiresInDays: body.expires_in_days,
    });
    await persistSharedView(db, view);
    await persistProjectStore(db, store);
    return {
      view,
      share_path: `/share/${view.id}`,
    };
  });

  app.get("/v1/shared/:viewId", async (req, reply) => {
    const { viewId } = req.params as { viewId: string };
    const store = await getDemoStore();
    const view = (await loadSharedView(db, viewId)) ?? getSharedView(store, viewId);
    if (!view) return reply.code(404).send({ error: "view_not_found" });
    let projectStore = store;
    if (view.project_id !== store.project.id) {
      const alt = await resolveProjectStore(db, view.project_id);
      if (!alt) return reply.code(404).send({ error: "project_not_found" });
      projectStore = alt;
    }
    const brands = metricsFromStore(projectStore).sort(
      (a, b) => b.visibility - a.visibility,
    );
    return {
      view,
      read_only: true,
      project: {
        id: projectStore.project.id,
        name: projectStore.project.name,
      },
      brands,
      meta: {
        chats: projectStore.chats.length,
        surface_kinds: [
          ...new Set(
            projectStore.chats
              .map((c) => c.surface_kind)
              .filter(
                (s): s is "ui" | "api" | "simulator" =>
                  s === "ui" || s === "api" || s === "simulator",
              ),
          ),
        ],
        surface_kind:
          projectStore.chats[0]?.surface_kind ?? "api",
      },
    };
  });

  app.delete(
    "/v1/projects/:projectId/views/:viewId",
    async (req, reply) => {
      const { projectId, viewId } = req.params as {
        projectId: string;
        viewId: string;
      };
      const store = await resolveProjectStore(db, projectId);
      if (!store) return reply.code(404).send({ error: "project_not_found" });
      const local = store.sharedViews.find((candidate) => candidate.id === viewId);
      if (local) local.revoked_at = new Date().toISOString();
      const persisted = await revokeSharedView(db, { projectId, viewId });
      if (!local && !persisted) {
        return reply.code(404).send({ error: "view_not_found" });
      }
      await persistProjectStore(db, store);
      return { ok: true };
    },
  );

  app.get("/v1/projects/:projectId/actions", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const q = req.query as { status?: string; group?: string };
    return listActions(store, {
      status: (q.status as "all" | "new" | "in_progress" | "done" | "declined") ?? "all",
      group: q.group,
    });
  });

  app.post("/v1/projects/:projectId/actions/generate", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const body = (req.body as { force?: boolean }) ?? {};
    const result = generateActionsForStore(store, { force: body.force });
    await persistProjectStore(db, store);
    return {
      count: result.actions.length,
      regenerated: result.regenerated,
      cooldown_ms: result.cooldown_ms,
      rows: result.actions,
    };
  });

  app.get("/v1/projects/:projectId/actions/:actionId", async (req, reply) => {
    const { projectId, actionId } = req.params as {
      projectId: string;
      actionId: string;
    };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const action = getAction(store, actionId);
    if (!action) return reply.code(404).send({ error: "action_not_found" });
    return { action };
  });

  app.post(
    "/v1/projects/:projectId/actions/:actionId/transition",
    async (req, reply) => {
      const { projectId, actionId } = req.params as {
        projectId: string;
        actionId: string;
      };
      const store = await resolveProjectStore(db, projectId);
      if (!store) return reply.code(404).send({ error: "project_not_found" });
      const body = req.body as {
        verb?: "accept" | "decline" | "complete" | "cancel";
      };
      if (!body.verb) return reply.code(400).send({ error: "verb_required" });
      const action = transitionAction(store, actionId, body.verb);
      if (!action) {
        return reply.code(400).send({ error: "invalid_transition" });
      }
      await persistProjectStore(db, store);
      return { action };
    },
  );

  app.post(
    "/v1/projects/:projectId/actions/:actionId/steps/:stepId/toggle",
    async (req, reply) => {
      const { projectId, actionId, stepId } = req.params as {
        projectId: string;
        actionId: string;
        stepId: string;
      };
      const store = await resolveProjectStore(db, projectId);
      if (!store) return reply.code(404).send({ error: "project_not_found" });
      const action = toggleActionStep(store, actionId, stepId);
      if (!action) return reply.code(404).send({ error: "not_found" });
      await persistProjectStore(db, store);
      return { action };
    },
  );

  app.get("/v1/projects/:projectId/impact", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    if (store.actions.length === 0) {
      generateActionsForStore(store, { force: true });
    }
    return impactFromStore(store);
  });

  app.get("/v1/projects/:projectId/agent/crawlability", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    // Fetch the real robots.txt once so the report reflects the live site
    // rather than assuming "allow all" for an unknown file.
    if (store.robotsTxt == null && store.project.domain) {
      const res = await refreshRobotsTxt(store);
      if (res.ok) await persistProjectStore(db, store);
    }
    return getCrawlability(store);
  });

  app.post(
    "/v1/projects/:projectId/agent/crawlability/refresh",
    async (req, reply) => {
      const { projectId } = req.params as { projectId: string };
      const store = await resolveProjectStore(db, projectId);
      if (!store) return reply.code(404).send({ error: "project_not_found" });
      const res = await refreshRobotsTxt(store);
      if (!res.ok) {
        return reply
          .code(502)
          .send({ error: res.error ?? "robots_fetch_failed", status: res.status });
      }
      await persistProjectStore(db, store);
      return { fetched: true, status: res.status, ...getCrawlability(store) };
    },
  );

  app.post("/v1/projects/:projectId/agent/url-tester", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const body = req.body as { url?: string };
    if (!body.url) return reply.code(400).send({ error: "url_required" });
    return runUrlTester(store, body.url);
  });

  app.get("/v1/projects/:projectId/agent/crawl-insights", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    return crawlInsightsDashboard(store);
  });

  app.post(
    "/v1/projects/:projectId/agent-analytics/generic-access-log",
    async (req, reply) => {
      const { projectId } = req.params as { projectId: string };
      const store = await resolveProjectStore(db, projectId);
      if (!store) return reply.code(404).send({ error: "project_not_found" });
      const result = ingestWebhookLogs(store, req.body);
      if (result.errors.some((e) => e.index === -1)) {
        return reply.code(400).send(result);
      }
      return result;
    },
  );

  app.post(
    "/v1/projects/:projectId/agent/crawl-insights/upload",
    async (req, reply) => {
      const { projectId } = req.params as { projectId: string };
      const store = await resolveProjectStore(db, projectId);
      if (!store) return reply.code(404).send({ error: "project_not_found" });
      const body = req.body as { text?: string };
      if (!body.text) return reply.code(400).send({ error: "text_required" });
      return ingestUploadedLogs(store, body.text);
    },
  );

  app.post(
    "/v1/projects/:projectId/agent/crawl-insights/cloudflare",
    async (req, reply) => {
      const { projectId } = req.params as { projectId: string };
      const store = await resolveProjectStore(db, projectId);
      if (!store) return reply.code(404).send({ error: "project_not_found" });
      return connectCloudflare(store);
    },
  );

  app.get("/v1/projects/:projectId/agent/referrals", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    return referralsOverview(store);
  });

  app.post("/v1/projects/:projectId/agent/referrals/import", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    try {
      const result = importReferralRows(store, (req.body as { rows?: unknown })?.rows);
      appendAuditLog(store, { source: "api", action: "referrals.import", project_id: projectId, after: result });
      await persistProjectStore(db, store);
      return result;
    } catch (error) { return reply.code(400).send({ error: "invalid_referral_import", message: error instanceof Error ? error.message : "Invalid import" }); }
  });

  app.post("/v1/agent/classify-referral", async (req) => {
    return classifySampleReferral((req.body ?? {}) as Record<string, string>);
  });

  app.get("/v1/projects/:projectId/perception/market", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    return marketPerceptionReport(store);
  });

  app.get("/v1/projects/:projectId/perception/objections", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    return objectionsReport(store);
  });

  app.get("/v1/projects/:projectId/perception/factcheck", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    return factcheckReport(store);
  });

  app.get("/v1/projects/:projectId/shopping/summary", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    return shoppingSummary(store);
  });

  app.get("/v1/projects/:projectId/shopping/products", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const q = req.query as { source?: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    return shoppingProductsReport(store, {
      source: q.source === "catalog" ? "catalog" : "all",
    });
  });

  app.get(
    "/v1/projects/:projectId/shopping/products/:productId",
    async (req, reply) => {
      const { projectId, productId } = req.params as {
        projectId: string;
        productId: string;
      };
      const store = await resolveProjectStore(db, projectId);
      if (!store) return reply.code(404).send({ error: "project_not_found" });
      const detail = shoppingProductDetail(store, productId);
      if (!detail) return reply.code(404).send({ error: "product_not_found" });
      return detail;
    },
  );

  app.get("/v1/projects/:projectId/shopping/merchants", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    return shoppingMerchantsReport(store);
  });

  app.get("/v1/projects/:projectId/shopping/attributes", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    return shoppingAttributesReport(store);
  });

  app.post("/v1/projects/:projectId/shopping/catalog", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const body = (req.body ?? {}) as { csv?: string };
    if (!body.csv || typeof body.csv !== "string") {
      return reply.code(400).send({ error: "csv_required" });
    }
    try {
      const result = ingestCatalogCsv(store, body.csv);
      await persistProjectStore(db, store);
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "csv_error";
      return reply.code(400).send({ error: msg });
    }
  });

  app.post("/v1/projects/:projectId/collect", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const gate = checkCollect(store);
    if (!gate.ok) {
      return reply.code(409).send({ error: gate.code, message: gate.message });
    }
    const body = (req.body ?? {}) as {
      run_date?: string;
      channel_ids?: string[];
      force_inline?: boolean;
    };
    if (body.force_inline === false && queueMode() === "bullmq" && !db) {
      return reply.code(409).send({
        error: "database_required",
        message: "Background collection requires PostgreSQL persistence.",
      });
    }
    // Respect GEO_ADAPTER_MODE / per-provider keys (default auto → fixture without keys)
    const result = await runProjectCollectAndApply(store, {
      observationId: randomUUID(),
      runDate: body.run_date,
      channelIds: body.channel_ids,
      forceInline: body.force_inline ?? true,
      seed: `api|${projectId}|${body.run_date ?? "today"}`,
    });
    if (db) {
      await persistCollectionEvidence(db, store);
    }
    return {
      ...result,
      queue_mode: queueMode(),
      note:
        result.mode === "inline"
          ? "Collection ran inline with observation-level idempotency"
          : "Collection queued",
    };
  });

  app.get("/v1/projects/:projectId/collect/status", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    return {
      queue_mode: queueMode(),
      prompts_active: store.prompts.filter((p) => p.status === "active").length,
      chats: store.chats.length,
    };
  });

  // —— Phase 10: OpenAPI, API keys, public customer API, CSV, BI, MCP ——

  app.get("/openapi.json", async () =>
    buildOpenApiDocument({
      serverUrl: process.env.API_URL ?? "http://127.0.0.1:3001",
    }),
  );
  app.get("/openapi/json", async () =>
    buildOpenApiDocument({
      serverUrl: process.env.API_URL ?? "http://127.0.0.1:3001",
    }),
  );

  app.post("/v1/projects/:projectId/api-keys", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const body = (req.body ?? {}) as { name?: string; scopes?: string[] };
    const created = await createApiKey(db, {
      organizationId: store.organization.id,
      projectId,
      name: body.name?.trim() || "default",
      scopes: (body.scopes as ("read" | "write" | "admin")[]) ?? ["read"],
    });
    appendAuditLog(store, {
      source: "api",
      action: "api_key.create",
      project_id: projectId,
      after: { id: created.record.id, name: created.record.name },
    });
    await persistProjectStore(db, store);
    return {
      api_key: created.plaintext,
      id: created.record.id,
      key_prefix: created.record.key_prefix,
      scopes: created.record.scopes,
      note: "Store this key now — it is shown only once.",
    };
  });

  app.get("/v1/projects/:projectId/api-keys", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const rows = await listApiKeys(db, {
      organizationId: store.organization.id,
      projectId,
    });
    return { rows };
  });

  app.delete("/v1/projects/:projectId/api-keys/:keyId", async (req, reply) => {
    const { projectId, keyId } = req.params as {
      projectId: string;
      keyId: string;
    };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const ok = await revokeApiKey(db, keyId, {
      organizationId: store.organization.id,
      projectId,
    });
    if (!ok) return reply.code(404).send({ error: "key_not_found" });
    appendAuditLog(store, {
      source: "api",
      action: "api_key.revoke",
      project_id: projectId,
      after: { id: keyId },
    });
    await persistProjectStore(db, store);
    return { ok: true };
  });

  app.get("/v1/projects/:projectId/exports/brands.csv", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header(
      "content-disposition",
      `attachment; filename="brands-${projectId}.csv"`,
    );
    return brandsReportCsv(store);
  });

  app.get("/v1/projects/:projectId/exports/chats.csv", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header(
      "content-disposition",
      `attachment; filename="chats-${projectId}.csv"`,
    );
    return chatsReportCsv(store);
  });

  app.get("/v1/mcp/tools", async () => ({
    tools: listPlannedTools(),
    slash_commands: listSlashCommands(),
  }));

  app.post("/v1/mcp/tools/:toolName", async (req, reply) => {
    const { toolName } = req.params as { toolName: string };
    const body = (req.body as Record<string, unknown>) ?? {};
    const projectId =
      typeof body.project_id === "string" ? body.project_id : DEMO_PROJECT_ID;
    const store = await resolveProjectStore(db, projectId);
    if (store) {
      const mcp = checkMcpFeature(store);
      if (!mcp.ok) {
        return reply.code(403).send({ error: mcp.code, message: mcp.message });
      }
    }
    try {
      return await callMcpTool(toolName, body, {
        databaseUrl: url ?? undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "tool_error";
      return reply.code(400).send({ error: msg });
    }
  });

  // —— Phase 11: billing, pause/pitch, audit, GDPR, SSO, checkout ——

  app.get("/v1/projects/:projectId/billing", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    return {
      ...commercialSummary(store),
      plans: listPurchasablePlans({
        billing_period: store.organization.billing_period,
      }),
    };
  });

  app.post("/v1/projects/:projectId/billing/plan", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    if (process.env.NODE_ENV === "production") {
      return reply.code(403).send({
        error: "checkout_required",
        message: "Production plan changes require a verified billing webhook.",
      });
    }
    const body = (req.body ?? {}) as {
      plan_code?: string;
      is_agency?: boolean;
      billing_period?: "monthly" | "annual";
    };
    if (!body.plan_code) {
      return reply.code(400).send({ error: "plan_code_required" });
    }
    setOrgPlan(store, body.plan_code, {
      is_agency: body.is_agency,
      billing_period: body.billing_period,
      source: "api",
    });
    await persistProjectStore(db, store);
    await persistCommercialSideEffects(db, store);
    return commercialSummary(store);
  });

  app.post("/v1/projects/:projectId/billing/checkout", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const body = (req.body ?? {}) as {
      plan_code?: string;
      success_url?: string;
      cancel_url?: string;
    };
    if (!body.plan_code) {
      return reply.code(400).send({ error: "plan_code_required" });
    }
    try {
      const session = await createCheckoutSession(store, body.plan_code, {
        success_url: body.success_url,
        cancel_url: body.cancel_url,
      });
      await persistProjectStore(db, store);
      await persistCommercialSideEffects(db, store);
      return { session };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "checkout_error";
      return reply.code(400).send({ error: msg });
    }
  });

  app.post(
    "/v1/projects/:projectId/billing/checkout/:sessionId/complete",
    async (req, reply) => {
      const { projectId, sessionId } = req.params as {
        projectId: string;
        sessionId: string;
      };
      const store = await resolveProjectStore(db, projectId);
      if (!store) return reply.code(404).send({ error: "project_not_found" });
      try {
        const result = completeCheckout(store, sessionId);
        await persistProjectStore(db, store);
        await persistCommercialSideEffects(db, store);
        return {
          ...result,
          billing: commercialSummary(store),
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "complete_error";
        return reply.code(400).send({ error: msg });
      }
    },
  );

  app.post("/v1/billing/webhook", async (req, reply) => {
    const raw =
      (req as { rawBody?: string }).rawBody ??
      (typeof req.body === "string"
        ? req.body
        : JSON.stringify(req.body ?? {}));
    const sigHeader = req.headers["stripe-signature"] as string | undefined;
    let signatureOk: boolean | undefined;
    if (process.env.STRIPE_WEBHOOK_SECRET) {
      signatureOk = verifyStripeWebhookSignature(raw, sigHeader);
      if (!signatureOk) {
        return reply.code(400).send({ error: "invalid_signature" });
      }
    }
    const body = (
      typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {})
    ) as {
      id?: string;
      type?: string;
      project_id?: string;
      data?: {
        object?: {
          id?: string;
          status?: string;
          client_reference_id?: string;
          metadata?: {
            checkout_session_id?: string;
            plan_code?: string;
            project_id?: string;
          };
        };
      };
    };
    const eventMetadata = billingEventMetadata(body as BillingEvent);
    const projectId = eventMetadata.project_id ?? body.project_id ??
      (process.env.NODE_ENV !== "production" && !process.env.STRIPE_WEBHOOK_SECRET ? DEMO_PROJECT_ID : undefined);
    if (!projectId) return { handled: false, reason: "unmapped_project" };
    if (process.env.NODE_ENV === "production" && !body.id) {
      return reply.code(400).send({ error: "stripe_event_id_required" });
    }
    if (body.id && (await billingWebhookWasProcessed(db, body.id))) {
      return { handled: true, duplicate: true };
    }
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    try {
      const result = handleBillingWebhook(store, body, {
        stripe_signature_ok: signatureOk,
      });
      if (result.handled) {
        await persistProjectStore(db, store);
        await persistCommercialSideEffects(db, store);
        if (body.id) {
          await recordBillingWebhookEvent(db, {
            eventId: body.id,
            eventType: body.type ?? "unknown",
            projectId,
          });
        }
      }
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "webhook_error";
      return reply.code(400).send({ error: msg });
    }
  });

  app.put("/v1/projects/:projectId/channels/enabled", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const body = (req.body ?? {}) as { channel_ids?: string[] };
    const d = setEnabledChannels(store, body.channel_ids ?? []);
    if (!d.ok) return reply.code(409).send({ error: d.code, message: d.message });
    await persistProjectStore(db, store);
    await persistCommercialSideEffects(db, store);
    return { channel_ids: store.commercial!.enabled_channel_ids };
  });

  app.post("/v1/projects/:projectId/pause", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const body = (req.body ?? {}) as { acknowledge_data_loss?: boolean };
    const d = pauseProject(store, {
      acknowledge_data_loss: Boolean(body.acknowledge_data_loss),
      source: "api",
    });
    if (!d.ok) return reply.code(400).send({ error: d.code, message: d.message });
    await persistProjectStore(db, store);
    await persistCommercialSideEffects(db, store);
    return { status: store.project.status, pause: commercialSummary(store).pause };
  });

  app.post("/v1/projects/:projectId/unpause", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const d = unpauseProject(store, { source: "api" });
    if (!d.ok) return reply.code(400).send({ error: d.code, message: d.message });
    await persistProjectStore(db, store);
    await persistCommercialSideEffects(db, store);
    return { status: store.project.status };
  });

  app.post("/v1/projects/:projectId/convert-pitch", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const d = convertPitchToCustomer(store, { source: "api" });
    if (!d.ok) return reply.code(400).send({ error: d.code, message: d.message });
    await persistProjectStore(db, store);
    await persistCommercialSideEffects(db, store);
    return { status: store.project.status };
  });

  app.get("/v1/projects/:projectId/audit-log", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    return { rows: listAuditLog(store) };
  });

  app.get("/v1/projects/:projectId/gdpr/export", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    return gdprExportProject(store);
  });

  app.post("/v1/projects/:projectId/gdpr/delete", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const result = gdprDeleteProjectData(store);
    await persistProjectStore(db, store);
    await persistCommercialSideEffects(db, store);
    return result;
  });

  app.get("/v1/projects/:projectId/sso", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    return commercialSummary(store).sso;
  });

  app.put("/v1/projects/:projectId/sso", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const body = (req.body ?? {}) as {
      idp_entity_id?: string;
      idp_sso_url?: string;
      idp_certificate_present?: boolean;
    };
    if (!body.idp_entity_id?.trim() || !body.idp_sso_url?.trim()) {
      return reply.code(400).send({ error: "idp_fields_required" });
    }
    const d = configureSso(store, {
      idp_entity_id: body.idp_entity_id,
      idp_sso_url: body.idp_sso_url,
      idp_certificate_present: body.idp_certificate_present,
    });
    if (!d.ok) {
      return reply.code(403).send({ error: d.code, message: d.message });
    }
    await persistProjectStore(db, store);
    await persistCommercialSideEffects(db, store);
    return commercialSummary(store).sso;
  });

  app.delete("/v1/projects/:projectId/sso", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    clearSso(store);
    await persistProjectStore(db, store);
    await persistCommercialSideEffects(db, store);
    return commercialSummary(store).sso;
  });

  app.get("/v1/projects/:projectId/sso/login", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const store = await resolveProjectStore(db, projectId);
    if (!store) return reply.code(404).send({ error: "project_not_found" });
    const result = buildIdpRedirectUrl(store, {
      relay_state: projectId,
    });
    if (!result.ok) {
      return reply
        .code(403)
        .send({ error: result.code, message: result.message });
    }
    await persistProjectStore(db, store);
    return result;
  });

  app.get("/v1/saml/metadata", async (_req, reply) => {
    reply.header("content-type", "application/samlmetadata+xml");
    return buildSpMetadataXml();
  });

  app.post("/v1/saml/acs", async (req, reply) => {
    const body = (req.body ?? {}) as {
      SAMLResponse?: string;
      RelayState?: string;
    };
    const email = parseSamlResponseEmail(body.SAMLResponse ?? "");
    if (!email) {
      return reply.code(400).send({ error: "invalid_saml_response" });
    }
    const projectId = body.RelayState ?? DEMO_PROJECT_ID;
    const store = await resolveProjectStore(db, projectId);
    if (store) {
      appendAuditLog(store, {
        source: "api",
        action: "sso.acs",
        after: { email },
      });
      await persistProjectStore(db, store);
    }
    if (!db) {
      // Memory demo: accept demo owner email only
      const demo = await getDemoStore();
      if (email !== demo.user.email.toLowerCase()) {
        return reply.code(401).send({ error: "sso_user_not_found" });
      }
      const web = process.env.WEB_URL ?? "http://127.0.0.1:3010";
      return reply.redirect(`${web}/${demo.project.id}/overview?sso=1`);
    }
    try {
      const result = await loginWithEmail(db, email);
      reply.setCookie(COOKIE, result.token, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 60 * 60 * 24 * 14,
      });
      const web = process.env.WEB_URL ?? "http://127.0.0.1:3010";
      const dest = result.project?.id ?? projectId;
      return reply.redirect(`${web}/${dest}/overview?sso=1`);
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(401).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.get("/v1/privacy/subprocessors", async () => ({
    rows: SUBPROCESSORS,
    residency: "EU primary datastore option documented for enterprise",
  }));

  async function withApiKeyProject(
    req: {
      headers: Record<string, unknown>;
      query?: unknown;
    },
    reply: {
      header: (k: string, v: string | number) => unknown;
      code: (n: number) => { send: (b: unknown) => unknown };
    },
    projectId: string,
  ): Promise<DemoStore | null> {
    const query =
      req.query && typeof req.query === "object"
        ? (req.query as Record<string, unknown>)
        : undefined;
    const rawKey =
      (req.headers["x-api-key"] as string | undefined) ??
      (typeof query?.api_key === "string" ? query.api_key : undefined);
    if (!rawKey) {
      reply.code(400).send({ message: "Missing API Key" });
      return null;
    }
    const key = await verifyApiKey(db, rawKey);
    if (!key) {
      reply.code(401).send({ message: "Invalid API Key" });
      return null;
    }
    const store = await resolveProjectStore(db, projectId);
    if (!store) {
      reply.code(404).send({ error: "project_not_found" });
      return null;
    }
    if (
      !assertKeyCanAccessProject(key, projectId, store.organization.id)
    ) {
      reply.code(403).send({ message: "Forbidden for this project" });
      return null;
    }
    const rl = checkProjectRateLimit(projectId);
    reply.header("X-RateLimit-Limit", rl.limit);
    reply.header("X-RateLimit-Remaining", rl.remaining);
    reply.header("X-RateLimit-Reset", rl.reset_seconds);
    if (!rl.ok) {
      reply.header("Retry-After", rl.reset_seconds);
      reply.code(429).send({ message: "Rate limit exceeded" });
      return null;
    }
    const api = checkApiFeature(store);
    if (!api.ok) {
      reply.code(403).send({ error: api.code, message: api.message });
      return null;
    }
    return store;
  }

  app.post("/customer/v1/reports/brands", async (req, reply) => {
    const body = (req.body ?? {}) as { project_id?: string };
    const projectId = body.project_id ?? DEMO_PROJECT_ID;
    const store = await withApiKeyProject(req, reply, projectId);
    if (!store) return;
    const report = brandsReportPayload(store);
    return {
      data: report.rows,
      total_count: report.rows.length,
      warnings: [],
      meta: report.meta,
      formula: report.formula,
    };
  });

  app.get("/customer/v1/bi/brands", async (req, reply) => {
    const q = req.query as { project_id?: string };
    const projectId = q.project_id ?? DEMO_PROJECT_ID;
    const store = await withApiKeyProject(req, reply, projectId);
    if (!store) return;
    const bi = checkBiFeature(store);
    if (!bi.ok) {
      return reply.code(403).send({ error: bi.code, message: bi.message });
    }
    return biBrandsFlat(store);
  });

  return app;
}

async function main() {
  const envFile = loadRepoEnv();
  clearAdapterCache();
  const runtime = describeAdapterRuntime();
  validateProductionConfiguration();
  console.log(
    `collection env=${envFile ?? "process"} mode=${runtime.GEO_ADAPTER_MODE} backend=${runtime.GEO_COLLECTION_BACKEND} openrouter=${runtime.openrouter_key_present} cursor=${runtime.cursor_key_present} resolved=${runtime.global_resolved}`,
  );
  if (!hasDatabaseUrl()) {
    console.warn("DATABASE_URL unset — API running in memory demo mode");
  }
  const port = Number(process.env.PORT ?? 3001);
  let attempt = 0;
  for (;;) {
    try {
      const app = await buildServer();
      await app.listen({ port, host: "0.0.0.0" });
      return;
    } catch (error) {
      const code =
        error instanceof Error
          ? (error as Error & { code?: string }).code
          : undefined;
      const transient =
        code === "ECONNRESET" ||
        code === "ECONNREFUSED" ||
        code === "ETIMEDOUT" ||
        code === "EHOSTUNREACH";
      if (!transient) throw error;
      attempt += 1;
      const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
      console.error(
        `API dependency unavailable (${code}); retrying startup in ${delayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

const isMain =
  process.argv[1] != null &&
  path.resolve(fileURLToPath(import.meta.url)) ===
    path.resolve(process.argv[1]);

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
