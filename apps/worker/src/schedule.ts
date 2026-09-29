import { DEFAULT_API_CHANNELS } from "@geo/adapters";
import type { DemoStore } from "@geo/db";
import { analysisScopedActivePrompts } from "@geo/db";
import { getChannel } from "@geo/registry";
import {
  buildCollectPayload,
  type CollectChannelResult,
  type CollectJobPayload,
} from "./collect.js";
import { type EnqueueResult, enqueueCollectJob } from "./queue.js";

export interface ScheduleCollectOptions {
  runDate?: string;
  channelIds?: string[];
  /** When true, process inline even if Redis is configured (tests). */
  forceInline?: boolean;
  seed?: string;
  /** Max concurrent inline LLM/adapter calls (default 4). */
  concurrency?: number;
  /** Stable for retries; distinct for independent repeat observations. */
  observationId?: string;
  /** Frozen at submission so delayed jobs cannot silently collect edited prompts. */
  snapshot?: CollectionSnapshot;
}

export type CollectionSnapshot = {
  run_date: string;
  skipped: { prompt_id: string; channel_id: string; reason: string }[];
  payloads: CollectJobPayload[];
};

/**
 * §6.1 scheduler: for each active prompt × channel, enqueue collect_job
 * with job_key idempotency. Skips unsupported country pairs (no chat row).
 */
export function snapshotProjectCollect(
  store: DemoStore,
  opts?: ScheduleCollectOptions,
): CollectionSnapshot {
  const runDate =
    opts?.runDate ?? new Date().toISOString().slice(0, 10);
  const channelIds = opts?.channelIds ?? [...DEFAULT_API_CHANNELS];
  const activeBrandIds = store.analysisScope?.brandIds;
  const brands = store.brands
    .filter((b) => !activeBrandIds || activeBrandIds.includes(b.id))
    .map((b) => ({
      brandId: b.id,
      name: b.name,
      aliases: [...b.aliases],
      patterns: [...b.patterns],
    }));

  const active = analysisScopedActivePrompts(store);
  const skipped: { prompt_id: string; channel_id: string; reason: string }[] =
    [];
  const payloads: CollectJobPayload[] = [];

    for (const prompt of active) {
      for (const channelId of channelIds) {
        const meta = getChannel(channelId);
        if (meta?.surface !== "api") {
          skipped.push({
            prompt_id: prompt.id,
            channel_id: channelId,
            reason: "UNKNOWN_CHANNEL",
          });
          continue;
        }
        if (
          meta.unsupportedCountryCodes.includes(
            prompt.country_code.toUpperCase(),
          )
        ) {
          skipped.push({
            prompt_id: prompt.id,
            channel_id: channelId,
            reason: "UNSUPPORTED_COUNTRY",
          });
          continue;
        }

        const payload = buildCollectPayload({
          projectId: store.project.id,
          promptId: prompt.id,
          promptText: prompt.text,
          channelId,
          countryCode: prompt.country_code,
          runDate,
          brands,
          seed: opts?.seed,
          observationId: opts?.observationId,
        });
        payloads.push(payload);
      }
    }

  return { run_date: runDate, skipped, payloads };
}

export async function scheduleProjectCollect(store: DemoStore, opts?: ScheduleCollectOptions) {
    const snapshot = opts?.snapshot ?? snapshotProjectCollect(store, opts);
    const { run_date: runDate, skipped, payloads } = snapshot;
    if (payloads.some((p) => p.project_id !== store.project.id)) throw new Error("collection_snapshot_project_mismatch");
    const enqueued: EnqueueResult[] = [];
    // Run independent adapter calls with bounded concurrency.
    const concurrency = Math.max(1, opts?.concurrency ?? 4);
    const results: EnqueueResult[] = new Array(payloads.length);
    let next = 0;
    async function worker() {
      while (next < payloads.length) {
        const i = next++;
        const payload = payloads[i]!;
        results[i] = await enqueueCollectJob(payload, { forceInline: opts?.forceInline });
      }
    }
    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, Math.max(1, payloads.length)) },
        () => worker(),
      ),
    );
    enqueued.push(...results);
  return {
    run_date: runDate,
    mode: opts?.forceInline ? "inline" : enqueued[0]?.mode ?? "inline",
    enqueued,
    skipped,
    payloads,
  };
}

/** Apply a single channel collect result onto the DemoStore (skipped = no row). */
export function applyCollectResultToStore(
  store: DemoStore,
  payload: CollectJobPayload,
  result: CollectChannelResult,
): { chat_id: string | null } {
  if (result.status === "skipped") {
    return { chat_id: null };
  }

  const chatId = `cht_${payload.job_key.slice(0, 16)}`;
  // Retry the same observation idempotently, retaining independent repeats.
  const existing = store.chats.find(
    (c) =>
      c.id === chatId,
  );
  if (existing) {
    return { chat_id: existing.id };
  }

  store.chats.push({
    id: chatId,
    project_id: payload.project_id,
    prompt_id: payload.prompt_id,
    model_channel_id: payload.channel_id,
    country_code: payload.country_code,
    run_date: payload.run_date,
    status:
      result.status === "ok" ||
      result.status === "empty" ||
      result.status === "error" ||
      result.status === "blocked"
        ? result.status
        : "error",
    text: result.text,
    raw_uri: `db://chat/${chatId}/raw`,
    raw_payload: result.rawPayload,
    surface_kind: result.surfaceKind,
    model_reported: result.modelReported,
    provider_request_id: result.providerRequestId,
    latency_ms: result.latencyMs,
    error_code: result.errorCode,
    error_detail: result.errorDetail,
    collected_at: new Date().toISOString(),
    retrieval_mode: result.rawPayload && typeof result.rawPayload === "object" && "grounded" in result.rawPayload && result.rawPayload.grounded === false ? "provider_api_ungrounded" : "provider_api",
    locale: `${store.project.language || "en"}-${payload.country_code}`,
    collector_version: process.env.GIT_SHA ?? "geolens-worker-v1",
    extraction_version: "brands-v1",
  });

  for (const m of result.mentions) {
    store.mentions.push({
      chat_id: chatId,
      brand_id: m.brandId,
      mention_count: m.mentionCount,
      position: m.position,
      sentiment: m.sentiment,
    });
  }
  for (const s of result.sources) {
    store.sources.push({
      chat_id: chatId,
      url: s.url,
      domain: s.domain,
      cited: s.cited,
      citation_count: s.citationCount,
      retrieval_rank: s.retrievalRank,
    });
  }

  return { chat_id: chatId };
}

/**
 * Schedule + run inline (or enqueue), then apply completed results to store.
 * Used by API when Redis is absent or forceInline.
 */
export async function runProjectCollectAndApply(
  store: DemoStore,
  opts?: ScheduleCollectOptions,
): Promise<{
  run_date: string;
  mode: string;
  chats_written: number;
  eligible_answers: number;
  failed_attempts: number;
  jobs: EnqueueResult[];
  skipped: { prompt_id: string; channel_id: string; reason: string }[];
}> {
  const schedule = await scheduleProjectCollect(store, {
    ...opts,
    forceInline: opts?.forceInline ?? true,
  });

  let chats_written = 0;
  for (let i = 0; i < schedule.payloads.length; i++) {
    const payload = schedule.payloads[i]!;
    const job = schedule.enqueued[i]!;
    if (job.status === "completed" && job.result) {
      const before = store.chats.length;
      const { chat_id } = applyCollectResultToStore(
        store,
        payload,
        job.result,
      );
      if (chat_id && store.chats.length > before) chats_written += 1;
    }
  }

  const observationIds = new Set(schedule.payloads.map((payload) => `cht_${payload.job_key.slice(0, 16)}`));
  const observed = store.chats.filter((chat) => observationIds.has(chat.id));
  return {
    run_date: schedule.run_date,
    mode: schedule.mode,
    chats_written,
    eligible_answers: observed.filter((chat) => chat.status === "ok" || chat.status === "empty").length,
    failed_attempts: observed.filter((chat) => chat.status === "error" || chat.status === "blocked").length,
    jobs: schedule.enqueued,
    skipped: schedule.skipped,
  };
}
