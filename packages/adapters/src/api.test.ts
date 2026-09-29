import { beforeEach, describe, expect, it } from "vitest";
import {
  AnthropicApiAdapter,
  CHANNEL_PROVIDER_ROUTE,
  clearAdapterCache,
  DEFAULT_API_CHANNELS,
  describeAdapterRuntime,
  fixtureEngineResponse,
  getAdapter,
  HttpStatusError,
  listBuiltAdapters,
  markChannelDown,
  OpenAiApiAdapter,
  openRouterMaxTokens,
  openRouterModelForChannel,
  PerplexityApiAdapter,
  resetChannelHealth,
  resetRateLimiters,
  resolveProviderMode,
  shouldUseOpenRouter,
  TokenBucket,
  withRetry,
} from "./index.js";

describe("API-first Peec channel adapters", () => {
  beforeEach(() => {
    process.env.GEO_ADAPTER_MODE = "fixture";
    clearAdapterCache();
    resetChannelHealth();
    resetRateLimiters();
  });

  it("routes truthful defaults to provider APIs", async () => {
    expect(DEFAULT_API_CHANNELS).toEqual([
      "openai-1",
      "perplexity-1",
      "google-3",
      "anthropic-1",
    ]);
    for (const id of DEFAULT_API_CHANNELS) {
      expect(CHANNEL_PROVIDER_ROUTE[id]).toBeTruthy();
      const a = getAdapter(id);
      expect(a.surfaceKind).toBe("api");
      const res = await a.run({
        prompt: "best CRM for agencies",
        countryCode: "US",
        channelId: id,
        modelId: "test",
        runDate: "2026-09-01",
        seed: "p6",
      });
      expect(res.meta.surfaceKind).toBe("api");
    }
  });

  it("Claude channel uses anthropic; GPT uses openai", () => {
    expect(CHANNEL_PROVIDER_ROUTE["anthropic-1"]?.provider).toBe("anthropic");
    expect(CHANNEL_PROVIDER_ROUTE["openai-1"]?.provider).toBe("openai");
    expect(CHANNEL_PROVIDER_ROUTE["google-3"]?.provider).toBe("google");
    expect(CHANNEL_PROVIDER_ROUTE["openrouter-free-1"]?.provider).toBe(
      "openrouter",
    );
  });

  it("token bucket refuses when empty", () => {
    const b = new TokenBucket(2, 0.001);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
  });

  it("withRetry retries 429 then succeeds", async () => {
    let n = 0;
    const out = await withRetry(
      async () => {
        n += 1;
        if (n < 3) throw new HttpStatusError(429, "slow down");
        return "ok";
      },
      { sleep: async () => undefined },
    );
    expect(out).toBe("ok");
    expect(n).toBe(3);
  });

  it("degraded/down channel returns error without silent empty ok", async () => {
    markChannelDown("openai-1", "test");
    const a = new OpenAiApiAdapter(undefined, "fixture");
    const res = await a.run({
      prompt: "x",
      countryCode: "US",
      channelId: "openai-1",
      modelId: "m",
      runDate: "2026-01-01",
    });
    expect(res.status).toBe("error");
    expect(res.errorCode).toBe("CHANNEL_DOWN");
  });

  it("listBuiltAdapters includes simulator and routed API channels", () => {
    expect(listBuiltAdapters().length).toBeGreaterThanOrEqual(5);
    expect(new PerplexityApiAdapter().capabilities.ads).toBe(false);
    expect(new AnthropicApiAdapter().capabilities.geo).toBe("none");
  });

  it("per-provider mode: missing key stays fixture even in live global", () => {
    const env = {
      GEO_ADAPTER_MODE: "live",
      OPENAI_API_KEY: "sk-test",
    };
    expect(resolveProviderMode("openai", env)).toBe("live");
    expect(resolveProviderMode("perplexity", env)).toBe("fixture");
    expect(resolveProviderMode("anthropic", env)).toBe("fixture");
    expect(resolveProviderMode("google", env)).toBe("fixture");
  });

  it("live OpenAI path calls fetch (mocked) and is not fixture", async () => {
    const orig = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(
        JSON.stringify({
          output_text: "Acme CRM leads for agencies",
          model: "gpt-4.1-mini",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const a = new OpenAiApiAdapter("sk-test", "live");
      const res = await a.run({
        prompt: "best CRM",
        countryCode: "US",
        channelId: "openai-1",
        modelId: "m",
        runDate: "2026-09-01",
      });
      expect(called).toBe(true);
      expect(res.status).toBe("ok");
      expect(res.text).toContain("Acme");
      expect(res.meta.surfaceKind).toBe("api");
      expect((res.raw as { live?: boolean }).live).toBe(true);
      expect((res.raw as { fixture?: boolean }).fixture).toBeUndefined();
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("routes through OpenRouter when backend=openrouter and the key is set", () => {
    process.env.GEO_ADAPTER_MODE = "auto";
    process.env.GEO_COLLECTION_BACKEND = "openrouter";
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    clearAdapterCache();
    expect(shouldUseOpenRouter("openai")).toBe(true);
    const a = getAdapter("openai-0");
    expect(a.constructor.name).toBe("OpenRouterRoutedAdapter");
  });

  it("bounds OpenRouter output budgets to a predictable collection size", () => {
    expect(openRouterMaxTokens({})).toBe(1200);
    expect(openRouterMaxTokens({ OPENROUTER_MAX_TOKENS: "32" })).toBe(128);
    expect(openRouterMaxTokens({ OPENROUTER_MAX_TOKENS: "9000" })).toBe(4096);
    expect(openRouterMaxTokens({ OPENROUTER_MAX_TOKENS: "invalid" })).toBe(1200);
    expect(openRouterMaxTokens({}, "openrouter-free-1")).toBe(600);
    expect(
      openRouterMaxTokens(
        { OPENROUTER_FREE_MAX_TOKENS: "480" },
        "openrouter-free-1",
      ),
    ).toBe(480);
  });

  it("keeps the OpenRouter free router as a truthful distinct channel", () => {
    expect(openRouterModelForChannel("openrouter-free-1", {})).toBe(
      "openrouter/free",
    );
    expect(
      shouldUseOpenRouter("openrouter", {
        GEO_ADAPTER_MODE: "auto",
        OPENROUTER_API_KEY: "sk-or-test",
      }),
    ).toBe(true);
    const rt = describeAdapterRuntime({
      GEO_ADAPTER_MODE: "auto",
      OPENROUTER_API_KEY: "sk-or-test",
    });
    expect(
      rt.channels.find((channel) => channel.channel_id === "openrouter-free-1"),
    ).toMatchObject({
      provider: "openrouter",
      mode: "live",
      via_openrouter: true,
    });
  });

  it("describeAdapterRuntime never claims live without a key", () => {
    const rt = describeAdapterRuntime({
      GEO_ADAPTER_MODE: "auto",
      OPENAI_API_KEY: "sk-x",
    });
    expect(rt.channels.find((c) => c.channel_id === "openai-1")?.mode).toBe(
      "live",
    );
    expect(
      rt.channels.find((c) => c.channel_id === "perplexity-1")?.mode,
    ).toBe("fixture");
    expect(rt.routing_policy).toMatch(/OPENROUTER_API_KEY/i);
  });

  it("can route only Google through OpenRouter even when a Gemini key exists", () => {
    const env = {
      GEO_ADAPTER_MODE: "auto",
      GEO_COLLECTION_BACKEND: "auto",
      GEO_GOOGLE_COLLECTION_BACKEND: "openrouter",
      OPENROUTER_API_KEY: "sk-or-test",
      GEMINI_API_KEY: "google-test",
      OPENAI_API_KEY: "openai-test",
    };
    expect(shouldUseOpenRouter("google", env)).toBe(true);
    expect(shouldUseOpenRouter("openai", env)).toBe(false);
    const rt = describeAdapterRuntime(env);
    const google = rt.channels.find((channel) => channel.channel_id === "google-3");
    expect(google?.via_openrouter).toBe(true);
    expect(google?.collection_backend).toBe("openrouter");
    expect(google?.route_note).toMatch(/not the native Gemini API/i);
    expect(openRouterModelForChannel("google-3", {})).toBe("google/gemini-2.5-flash");
  });

  it("reports an OpenRouter-backed channel as live using the effective route key", () => {
    const rt = describeAdapterRuntime({
      GEO_ADAPTER_MODE: "auto",
      GEO_COLLECTION_BACKEND: "auto",
      OPENROUTER_API_KEY: "sk-or-test",
    });
    const openai = rt.channels.find((channel) => channel.channel_id === "openai-1");
    expect(openai).toMatchObject({
      key_present: true,
      native_key_present: false,
      mode: "live",
      via_openrouter: true,
      via_cursor: false,
    });
  });

  it("does not claim Cursor fallback when OpenRouter is explicitly selected without a key", () => {
    const rt = describeAdapterRuntime({
      GEO_ADAPTER_MODE: "auto",
      GEO_COLLECTION_BACKEND: "openrouter",
      CURSOR_API_KEY: "cursor-test",
    });
    const openai = rt.channels.find((channel) => channel.channel_id === "openai-1");
    expect(openai).toMatchObject({
      key_present: false,
      mode: "fixture",
      via_openrouter: false,
      via_cursor: false,
    });
  });

  it("fails closed instead of generating fixture evidence in production", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousAllow = process.env.GEO_ALLOW_PRODUCTION_FIXTURES;
    process.env.NODE_ENV = "production";
    delete process.env.GEO_ALLOW_PRODUCTION_FIXTURES;
    try {
      const result = fixtureEngineResponse(
        {
          prompt: "best CRM",
          countryCode: "US",
          channelId: "openai-1",
          modelId: "gpt-test",
          runDate: "2026-09-18",
        },
        {
          provider: "openai",
          modelReported: "gpt-test",
          brandBias: ["Acme"],
        },
      );
      expect(result.status).toBe("blocked");
      expect(result.errorCode).toBe("PROVIDER_NOT_CONFIGURED");
      expect(result.text).toBe("");
      expect(result.sources).toEqual([]);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousAllow === undefined) delete process.env.GEO_ALLOW_PRODUCTION_FIXTURES;
      else process.env.GEO_ALLOW_PRODUCTION_FIXTURES = previousAllow;
    }
  });
});
