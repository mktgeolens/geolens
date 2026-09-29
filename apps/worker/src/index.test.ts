import { CHANNEL_PROVIDER_ROUTE } from "@geo/adapters";
import { getDemoStore, resetDemoStore } from "@geo/db";
import { describe, expect, it } from "vitest";
import {
  collectJobKey,
  processCollectJob,
  projectCollectionIsDue,
  resetInlineJobState,
  runCollectEnrichJob,
  runProjectCollectAndApply,
  scheduleProjectCollect,
  setCollectJobHandler,
  snapshotProjectCollect,
} from "./index.js";

describe("runCollectEnrichJob", () => {
  it("collects across ≥3 API providers with surface_kind=api", async () => {
    process.env.GEO_ADAPTER_MODE = "fixture";
    const result = await runCollectEnrichJob({
      prompt: "best CRM for a 20-person agency",
      countryCode: "US",
      runDate: "2026-03-01",
      seed: "worker-test",
      brands: [
        { brandId: "br_acme", name: "Acme", aliases: [], patterns: [] },
        {
          brandId: "br_beta",
          name: "BetaSoft",
          aliases: [],
          patterns: [],
        },
      ],
    });
    expect(result.results.length).toBeGreaterThanOrEqual(3);
    const okish = result.results.filter((r) => r.status === "ok");
    expect(okish.length).toBeGreaterThan(0);
    for (const r of okish) {
      expect(r.surfaceKind).toBe("api");
      expect(r.text.length).toBeGreaterThan(0);
    }
    const providers = new Set(
      result.results.map((r) => CHANNEL_PROVIDER_ROUTE[r.channelId]?.provider),
    );
    providers.delete(undefined);
    expect(providers.size).toBeGreaterThanOrEqual(3);
  });
});

describe("job_key + schedule", () => {
  it("retains failure evidence without counting it as successful analysis", async () => {
    resetDemoStore();
    resetInlineJobState();
    const store = await getDemoStore();
    setCollectJobHandler(async (payload) => ({ channelId: payload.channel_id, status: "error", text: "", mentions: [], sources: [], surfaceKind: "api", errorCode: "HTTP_401" }));
    try {
      const result = await runProjectCollectAndApply(store, { forceInline: true, channelIds: ["openai-1"], observationId: "failed-test" });
      expect(result.chats_written).toBeGreaterThan(0);
      expect(result.failed_attempts).toBe(result.chats_written);
      expect(result.eligible_answers).toBe(0);
    } finally {
      setCollectJobHandler(processCollectJob);
      resetInlineJobState();
    }
  });
  it("freezes prompt text and brand aliases when an analysis is submitted", async () => {
    resetDemoStore();
    const store = await getDemoStore();
    const snapshot = snapshotProjectCollect(store, { observationId: "snapshot-test", channelIds: ["openai-1"] });
    const first = snapshot.payloads[0]!;
    const original = first.prompt_text;
    store.prompts.find((p) => p.id === first.prompt_id)!.text = "Edited after submission";
    store.brands[0]!.aliases.push("Later alias");
    expect(first.prompt_text).toBe(original);
    expect(first.brands.some((b) => b.aliases.includes("Later alias"))).toBe(false);
  });
  it("does not schedule active prompts outside the current analysis scope", async () => {
    resetDemoStore();
    const store = await getDemoStore();
    const scoped = store.prompts.find((prompt) => prompt.status === "active")!;
    store.analysisScope = {
      domain: store.project.domain!,
      brandIds: store.brands.map((brand) => brand.id),
      topicIds: [],
      promptIds: [scoped.id],
      startedAt: new Date().toISOString(),
    };
    store.prompts.push({
      ...scoped,
      id: "pr_unscoped_worker",
      text: "unrelated active prompt",
      country_code: "AU",
    });

    const snapshot = snapshotProjectCollect(store, { channelIds: ["openai-1"] });
    expect(snapshot.payloads.map((payload) => payload.prompt_id)).toEqual([scoped.id]);
  });
  it("skips retired and unknown channel ids before jobs are created", async () => {
    resetDemoStore();
    const store = await getDemoStore();
    const snapshot = snapshotProjectCollect(store, {
      channelIds: ["perplexity-1", "google-ai-mode", "openai-0"],
      observationId: "unsupported-channel-test",
    });
    expect(snapshot.payloads.length).toBe(
      store.prompts.filter((prompt) => prompt.status === "active").length,
    );
    expect(new Set(snapshot.payloads.map((payload) => payload.channel_id))).toEqual(
      new Set(["perplexity-1"]),
    );
    expect(snapshot.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel_id: "google-ai-mode", reason: "UNKNOWN_CHANNEL" }),
        expect.objectContaining({ channel_id: "openai-0", reason: "UNKNOWN_CHANNEL" }),
      ]),
    );
  });
  it("honors daily and weekly project collection frequency", () => {
    expect(
      projectCollectionIsDue({
        frequency: "daily",
        runDate: "2026-09-17",
        latestRunDate: "2026-09-16",
      }),
    ).toBe(true);
    expect(
      projectCollectionIsDue({
        frequency: "weekly",
        runDate: "2026-09-17",
        latestRunDate: "2026-09-11",
      }),
    ).toBe(false);
    expect(
      projectCollectionIsDue({
        frequency: "weekly",
        runDate: "2026-09-17",
        latestRunDate: "2026-09-10",
      }),
    ).toBe(true);
  });

  it("job_key is stable sha256 of identity fields", () => {
    const a = collectJobKey({
      projectId: "prj_1",
      promptId: "pr_1",
      channelId: "openai-1",
      countryCode: "us",
      runDate: "2026-09-01",
    });
    const b = collectJobKey({
      projectId: "prj_1",
      promptId: "pr_1",
      channelId: "openai-1",
      countryCode: "US",
      runDate: "2026-09-01",
    });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("schedules idempotent inline collect and writes chats", async () => {
    process.env.GEO_ADAPTER_MODE = "fixture";
    delete process.env.REDIS_URL;
    resetInlineJobState();
    resetDemoStore();
    const store = await getDemoStore();
    const before = store.chats.length;

    const first = await runProjectCollectAndApply(store, {
      runDate: "2026-09-05",
      forceInline: true,
      seed: "sched-1",
      channelIds: ["openai-1", "perplexity-1", "anthropic-1"],
    });
    expect(first.chats_written).toBeGreaterThan(0);
    expect(store.chats.length).toBeGreaterThan(before);

    const second = await scheduleProjectCollect(store, {
      runDate: "2026-09-05",
      forceInline: true,
      seed: "sched-1",
      channelIds: ["openai-1"],
    });
    expect(second.enqueued.every((j) => j.status === "duplicate")).toBe(true);
    const afterFirst = store.chats.length;
    await runProjectCollectAndApply(store, {
      runDate: "2026-09-05",
      forceInline: true,
      observationId: "independent-repeat",
      channelIds: ["openai-1"],
    });
    expect(store.chats.length).toBeGreaterThan(afterFirst);
    const afterRepeat = store.chats.length;
    const repeated = await runProjectCollectAndApply(store, {
      runDate: "2026-09-05",
      forceInline: true,
      observationId: "independent-repeat",
      channelIds: ["openai-1"],
    });
    expect(store.chats.length).toBe(afterRepeat);
    expect(repeated.eligible_answers).toBeGreaterThan(0);
  }, 60_000);
});
