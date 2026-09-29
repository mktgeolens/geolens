import {
  canActivatePrompt,
  canAddCountry,
  canCallApi,
  canCollect,
  canCreateProject,
  canEnableChannel,
  canIngestBotVisit,
  canUseBi,
  canUseMcp,
  canUseSso,
  computeProjectCredits,
  getPlan,
  type QuotaContext,
  type QuotaDecision,
  quotaSummary,
} from "@geo/core";
import { getChannel } from "@geo/registry";
import { newId } from "./schema.js";
import type { DemoStore } from "./seed.js";

export type AuditSource = "web" | "api" | "mcp";

export type AuditLogEntry = {
  id: string;
  organization_id: string;
  project_id?: string;
  actor_user_id?: string;
  actor_label?: string;
  source: AuditSource;
  action: string;
  before?: unknown;
  after?: unknown;
  created_at: string;
};

export type CommercialState = {
  enabled_channel_ids: string[];
  countries: string[];
  bot_visits_used: number;
  credits_total: number | null;
  project_count: number;
  paused_at?: string;
  pause_acknowledged?: boolean;
  stripe_customer_id?: string;
  stripe_subscription_status?: "none" | "active" | "past_due" | "canceled";
  sso?: {
    configured: boolean;
    idp_entity_id?: string;
    idp_sso_url?: string;
    idp_certificate_present?: boolean;
  };
};

export function ensureCommercial(store: DemoStore): CommercialState {
  if (!store.auditLog) store.auditLog = [];
  if (!store.commercial) {
    const channels = [
      ...new Set(store.chats.map((c) => c.model_channel_id)),
    ].sort();
    const countries = [
      ...new Set([
        store.project.default_country,
        ...store.prompts.map((p) => p.country_code),
      ]),
    ].sort();
    const plan = getPlan(store.organization.plan_code);
    store.commercial = {
      enabled_channel_ids: channels.length ? channels : ["openai-1", "sim-0"].slice(0, plan.max_channels),
      countries: countries.length ? countries : [store.project.default_country],
      bot_visits_used: store.organization.bot_visits_used ?? 0,
      credits_total:
        store.organization.credits_total ?? plan.credits_total ?? null,
      project_count: 1,
    };
  }
  return store.commercial;
}

export function buildQuotaContext(store: DemoStore): QuotaContext {
  const c = ensureCommercial(store);
  const active = uniqueActivePrompts(store).length;
  return {
    plan_code: store.organization.plan_code,
    is_agency: store.organization.is_agency,
    credits_total: c.credits_total,
    credits_allocated: computeProjectCredits({
      active_prompts: active,
      active_channels: Math.max(1, c.enabled_channel_ids.length),
      frequency: store.project.frequency,
    }),
    project_count: c.project_count,
    project_status: store.project.status,
    active_prompts: active,
    enabled_channels: c.enabled_channel_ids.length,
    countries: c.countries.length,
    bot_visits_used: c.bot_visits_used,
    frequency: store.project.frequency,
  };
}

export function commercialSummary(store: DemoStore) {
  const ctx = buildQuotaContext(store);
  const summary = quotaSummary(ctx);
  const c = ensureCommercial(store);
  const ssoGate = canUseSso(ctx);
  return {
    ...summary,
    project_id: store.project.id,
    organization_id: store.organization.id,
    pause: {
      paused_at: c.paused_at ?? null,
      warning:
        "Pausing stops all prompts, frees allocation, and permanently loses data for the paused period.",
    },
    billing: {
      stripe_customer_id: c.stripe_customer_id ?? null,
      subscription_status: c.stripe_subscription_status ?? "none",
      mode: process.env.STRIPE_SECRET_KEY ? "stripe" : "mock",
    },
    sso: {
      available: ssoGate.ok,
      configured: Boolean(c.sso?.configured),
      idp_entity_id: c.sso?.idp_entity_id ?? null,
      idp_sso_url: c.sso?.idp_sso_url ?? null,
      idp_certificate_present: Boolean(c.sso?.idp_certificate_present),
      message: ssoGate.ok
        ? c.sso?.configured
          ? "SSO configured — members can sign in via SAML."
          : "SSO available on this plan — configure your IdP."
        : ssoGate.message,
    },
  };
}

export function appendAuditLog(
  store: DemoStore,
  entry: Omit<AuditLogEntry, "id" | "created_at" | "organization_id"> & {
    organization_id?: string;
  },
): AuditLogEntry {
  ensureCommercial(store);
  const row: AuditLogEntry = {
    id: newId("aud"),
    organization_id: entry.organization_id ?? store.organization.id,
    project_id: entry.project_id,
    actor_user_id: entry.actor_user_id,
    actor_label: entry.actor_label,
    source: entry.source,
    action: entry.action,
    before: entry.before,
    after: entry.after,
    created_at: new Date().toISOString(),
  };
  store.auditLog!.push(row);
  return row;
}

export function listAuditLog(store: DemoStore, limit = 50) {
  ensureCommercial(store);
  return (store.auditLog ?? [])
    .slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}

export function setEnabledChannels(
  store: DemoStore,
  channelIds: string[],
): QuotaDecision {
  const ctx = buildQuotaContext(store);
  const unique = [...new Set(channelIds)];
  const unsupported = unique.filter(
    (channelId) => getChannel(channelId)?.surface !== "api",
  );
  if (unsupported.length > 0) {
    return {
      ok: false,
      code: "unknown_channel",
      message: `Unsupported collection channel${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}`,
    };
  }
  const adding = Math.max(0, unique.length - ctx.enabled_channels);
  if (adding > 0) {
    const d = canEnableChannel(ctx, adding);
    if (!d.ok) return d;
  }
  const before = ensureCommercial(store).enabled_channel_ids;
  store.commercial!.enabled_channel_ids = unique;
  appendAuditLog(store, {
    source: "web",
    action: "channels.set",
    project_id: store.project.id,
    before,
    after: unique,
  });
  return { ok: true };
}

export function addCountry(store: DemoStore, country: string): QuotaDecision {
  const code = country.toUpperCase().slice(0, 2);
  const c = ensureCommercial(store);
  if (c.countries.includes(code)) return { ok: true };
  const d = canAddCountry(buildQuotaContext(store), 1);
  if (!d.ok) return d;
  c.countries.push(code);
  appendAuditLog(store, {
    source: "web",
    action: "countries.add",
    project_id: store.project.id,
    after: code,
  });
  return { ok: true };
}

export function ingestBotVisit(store: DemoStore, count = 1): QuotaDecision {
  const ctx = buildQuotaContext(store);
  for (let i = 0; i < count; i++) {
    const d = canIngestBotVisit({
      ...ctx,
      bot_visits_used: ensureCommercial(store).bot_visits_used,
    });
    if (!d.ok) return d;
    store.commercial!.bot_visits_used += 1;
    store.organization.bot_visits_used = store.commercial!.bot_visits_used;
  }
  return { ok: true };
}

export function pauseProject(
  store: DemoStore,
  opts: { acknowledge_data_loss: boolean; source?: AuditSource },
): QuotaDecision {
  if (!opts.acknowledge_data_loss) {
    return {
      ok: false,
      code: "ack_required",
      message:
        "Confirm that pausing permanently loses data for the paused period.",
    };
  }
  const before = store.project.status;
  for (const p of store.prompts) {
    if (p.status === "active") p.status = "paused";
  }
  store.project.status = "PAUSED";
  const c = ensureCommercial(store);
  c.paused_at = new Date().toISOString();
  c.pause_acknowledged = true;
  appendAuditLog(store, {
    source: opts.source ?? "web",
    action: "project.pause",
    project_id: store.project.id,
    before: { status: before },
    after: { status: "PAUSED", paused_at: c.paused_at },
  });
  return { ok: true };
}

export function unpauseProject(
  store: DemoStore,
  opts?: { source?: AuditSource },
): QuotaDecision {
  if (store.project.status !== "PAUSED") {
    return { ok: false, code: "not_paused", message: "Project is not paused." };
  }
  store.project.status = "CUSTOMER";
  const c = ensureCommercial(store);
  const pausedAt = c.paused_at;
  delete c.paused_at;
  appendAuditLog(store, {
    source: opts?.source ?? "web",
    action: "project.unpause",
    project_id: store.project.id,
    before: { status: "PAUSED", paused_at: pausedAt },
    after: { status: "CUSTOMER" },
  });
  return { ok: true };
}

export function convertPitchToCustomer(
  store: DemoStore,
  opts?: { source?: AuditSource },
): QuotaDecision {
  if (store.project.status !== "PITCH") {
    return {
      ok: false,
      code: "not_pitch",
      message: "Only PITCH projects convert in place.",
    };
  }
  store.project.status = "CUSTOMER";
  appendAuditLog(store, {
    source: opts?.source ?? "web",
    action: "project.convert_pitch",
    project_id: store.project.id,
    before: { status: "PITCH" },
    after: { status: "CUSTOMER" },
  });
  return { ok: true };
}

export function createPitchProjectMeta(store: DemoStore) {
  store.project.status = "PITCH";
  ensureCommercial(store);
  appendAuditLog(store, {
    source: "web",
    action: "project.pitch_created",
    project_id: store.project.id,
    after: { status: "PITCH" },
  });
}

export function setOrgPlan(
  store: DemoStore,
  planCode: string,
  opts?: {
    is_agency?: boolean;
    source?: AuditSource;
    billing_period?: "monthly" | "annual";
  },
) {
  const plan = getPlan(planCode);
  const before = {
    plan_code: store.organization.plan_code,
    is_agency: store.organization.is_agency,
    billing_period: store.organization.billing_period,
  };
  store.organization.plan_code = plan.code;
  store.organization.is_agency =
    opts?.is_agency ?? plan.track === "agency";
  if (opts?.billing_period) {
    store.organization.billing_period = opts.billing_period;
  }
  const c = ensureCommercial(store);
  c.credits_total = plan.credits_total;
  store.organization.credits_total = plan.credits_total;
  appendAuditLog(store, {
    source: opts?.source ?? "web",
    action: "org.plan_change",
    before,
    after: {
      plan_code: plan.code,
      is_agency: store.organization.is_agency,
      billing_period: store.organization.billing_period,
    },
  });
}

/** Mark onboarding complete and optionally apply plan / billing period. */
export function completeOnboarding(
  store: DemoStore,
  opts?: {
    plan_code?: string;
    billing_period?: "monthly" | "annual";
    /** Keep trial plan (Start free trial CTA). */
    keep_trial?: boolean;
    source?: AuditSource;
  },
) {
  const before = store.project.status;
  store.project.status = "CUSTOMER";
  if (opts?.billing_period) {
    store.organization.billing_period = opts.billing_period;
  }
  if (opts?.plan_code && !opts.keep_trial) {
    setOrgPlan(store, opts.plan_code, {
      source: opts.source ?? "web",
      billing_period: opts.billing_period,
    });
  }
  appendAuditLog(store, {
    source: opts?.source ?? "web",
    action: "onboarding.complete",
    project_id: store.project.id,
    before: { status: before },
    after: {
      status: "CUSTOMER",
      plan_code: store.organization.plan_code,
      billing_period: store.organization.billing_period,
    },
  });
  return store.project;
}

export function checkPromptActivation(
  store: DemoStore,
  adding = 1,
): QuotaDecision {
  return canActivatePrompt(buildQuotaContext(store), adding);
}

export function checkCollect(store: DemoStore): QuotaDecision {
  return canCollect(buildQuotaContext(store));
}

export function checkApiFeature(store: DemoStore): QuotaDecision {
  return canCallApi(buildQuotaContext(store));
}

export function checkMcpFeature(store: DemoStore): QuotaDecision {
  return canUseMcp(buildQuotaContext(store));
}

export function checkBiFeature(store: DemoStore): QuotaDecision {
  return canUseBi(buildQuotaContext(store));
}

export function checkSsoFeature(store: DemoStore): QuotaDecision {
  return canUseSso(buildQuotaContext(store));
}

export function checkCreateProject(store: DemoStore): QuotaDecision {
  return canCreateProject(buildQuotaContext(store));
}

export function configureSso(
  store: DemoStore,
  input: {
    idp_entity_id: string;
    idp_sso_url: string;
    idp_certificate_present?: boolean;
  },
): QuotaDecision {
  const gate = checkSsoFeature(store);
  if (!gate.ok) return gate;
  const c = ensureCommercial(store);
  const before = c.sso ? { ...c.sso } : null;
  c.sso = {
    configured: true,
    idp_entity_id: input.idp_entity_id.trim(),
    idp_sso_url: input.idp_sso_url.trim(),
    idp_certificate_present: Boolean(input.idp_certificate_present ?? true),
  };
  appendAuditLog(store, {
    source: "web",
    action: "sso.configure",
    before,
    after: c.sso,
  });
  return { ok: true };
}

export function clearSso(store: DemoStore) {
  const c = ensureCommercial(store);
  const before = c.sso;
  c.sso = { configured: false };
  appendAuditLog(store, {
    source: "web",
    action: "sso.clear",
    before,
    after: c.sso,
  });
}

/** DSAR export — project-scoped JSON package (§19.4). */
export function gdprExportProject(store: DemoStore) {
  ensureCommercial(store);
  return {
    exported_at: new Date().toISOString(),
    retention_note:
      "Agent client_ip truncated after 30 days; non-AI traffic never stored.",
    organization: store.organization,
    project: store.project,
    user: store.user,
    brands: store.brands,
    prompts: store.prompts,
    chats: store.chats.map((c) => ({
      id: c.id,
      prompt_id: c.prompt_id,
      run_date: c.run_date,
      model_channel_id: c.model_channel_id,
      status: c.status,
    })),
    audit_log: listAuditLog(store, 500),
    commercial: store.commercial,
  };
}

/** Soft-delete project config for DSAR — clears PII-bearing extension fields. */
export function gdprDeleteProjectData(store: DemoStore) {
  appendAuditLog(store, {
    source: "api",
    action: "gdpr.delete_project",
    project_id: store.project.id,
  });
  store.user = {
    ...store.user,
    email: `deleted+${store.user.id}@invalid.local`,
    name: "Deleted User",
  };
  store.agentLogs = [];
  store.gaReferrals = [];
  store.chats = [];
  store.mentions = [];
  store.sources = [];
  return { ok: true as const, deleted_at: new Date().toISOString() };
}

export const SUBPROCESSORS = [
  { name: "PostgreSQL (self-hosted / cloud)", purpose: "primary datastore" },
  { name: "Redis", purpose: "job queue" },
  { name: "LLM providers (OpenAI / Anthropic / Perplexity)", purpose: "collection when keys set" },
];

import { uniqueActivePrompts } from "./promptIdentity.js";
