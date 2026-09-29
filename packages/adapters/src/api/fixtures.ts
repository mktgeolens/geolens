/**
 * Provider-flavored deterministic fixtures + per-provider live/fixture mode.
 * Collection is API-first: each Peec-like channel routes to a provider model
 * (GPT → OpenAI, Claude → Anthropic, Gemini → Google, etc.).
 */
import type { EngineRequest, EngineResponse, RawSource } from "../types.js";

/** FNV-1a for deterministic fixture answers without network. */
function hash32(...parts: string[]): number {
  let h = 0x811c9dc5;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export type ProviderId =
  | "openai"
  | "openrouter"
  | "perplexity"
  | "anthropic"
  | "google"
  | "copilot";

export function collectionBackendForProvider(
  provider: ProviderId,
  env: Record<string, string | undefined> = process.env,
): string {
  const key = `GEO_${provider.toUpperCase()}_COLLECTION_BACKEND`;
  return (env[key] ?? env.GEO_COLLECTION_BACKEND ?? "auto").toLowerCase();
}

/**
 * Provider-flavored deterministic responses so channel-level differences
 * are visible without live credentials. Each provider biases brand order.
 */
export function fixtureEngineResponse(
  req: EngineRequest,
  opts: {
    provider: ProviderId;
    modelReported: string;
    /** Brand names in preferred order for this provider's "personality". */
    brandBias: string[];
  },
): EngineResponse {
  const t0 = Date.now();
  if (
    process.env.NODE_ENV === "production" &&
    process.env.GEO_ALLOW_PRODUCTION_FIXTURES !== "true"
  ) {
    return {
      status: "blocked",
      errorCode: "PROVIDER_NOT_CONFIGURED",
      text: "",
      sources: [],
      fanouts: [],
      ads: [],
      products: [],
      maps: [],
      features: [],
      raw: {
        fixture: false,
        provider: opts.provider,
        reason: "production_fixture_disabled",
      },
      meta: {
        modelReported: opts.modelReported,
        latencyMs: Date.now() - t0,
        surfaceKind: "api",
      },
    };
  }
  const rng = mulberry32(
    hash32(
      req.seed ?? "fixture",
      opts.provider,
      req.prompt,
      req.channelId,
      req.runDate,
    ),
  );

  const roll = rng();
  if (opts.provider === "openai" && roll < 0.02) {
    return empty(opts, t0, "RATE_LIMIT_SIM");
  }
  if (opts.provider === "anthropic" && roll < 0.015) {
    return empty(opts, t0, "OVERLOADED");
  }
  if (opts.provider === "google" && roll < 0.02) {
    return empty(opts, t0, "GROUNDING_TIMEOUT");
  }

  const brands =
    req.trackedBrands && req.trackedBrands.length > 0
      ? [...req.trackedBrands]
      : [...opts.brandBias];
  if (rng() < 0.35 && brands.length > 1) {
    const i = 1 + Math.floor(rng() * (brands.length - 1));
    const tmp = brands[0]!;
    brands[0] = brands[i]!;
    brands[i] = tmp;
  }

  const lead = brands[0] ?? opts.brandBias[0] ?? "Unknown";
  const rest = brands.slice(1, 4);
  let text = `${lead} is frequently recommended for ${req.prompt}`;
  if (rest.length) {
    text += `, with ${rest.join(" and ")} also appearing in evaluations`;
  }
  text += `. (${opts.provider} fixture surface)`;

  const sourceCount =
    opts.provider === "perplexity"
      ? 5 + Math.floor(rng() * 4)
      : opts.provider === "openai" || opts.provider === "copilot"
        ? 2 + Math.floor(rng() * 3)
        : opts.provider === "google"
          ? 4 + Math.floor(rng() * 3)
          : 3 + Math.floor(rng() * 3);

  const domains =
    opts.provider === "perplexity"
      ? ["g2.com", "reddit.com", "techcrunch.com", "wikipedia.org", "forbes.com"]
      : opts.provider === "google"
        ? ["wikipedia.org", "nytimes.com", "g2.com", "reddit.com", "forbes.com"]
        : opts.provider === "openai" || opts.provider === "copilot"
          ? ["techcrunch.com", "betasoft.example", "g2.com", "forbes.com"]
          : ["forbes.com", "medium.com", "g2.com", "reddit.com"];

  const sources: RawSource[] = [];
  for (let i = 0; i < sourceCount; i++) {
    const domain = domains[i % domains.length]!;
    const cited =
      opts.provider === "perplexity" || opts.provider === "google"
        ? rng() < 0.7
        : rng() < 0.45;
    sources.push({
      url: `https://${domain}/p/${Math.floor(rng() * 9000) + 1000}`,
      title: `${domain} result`,
      cited,
      citationCount: cited ? 1 + Math.floor(rng() * 2) : 0,
      citationPosition: cited ? i + 1 : undefined,
      retrievalRank: i + 1,
    });
  }

  const fanouts =
    rng() < 0.8
      ? [
          { text: `${req.prompt} pricing`, type: "search" as const },
          {
            text: `${lead} vs ${rest[0] ?? "competitors"}`,
            type: "search" as const,
          },
        ]
      : [];

  return {
    status: "ok",
    text,
    sources,
    fanouts,
    ads: [],
    products: [],
    maps: [],
    features: [{ type: "web_search" }],
    raw: {
      fixture: true,
      provider: opts.provider,
      brands,
    },
    meta: {
      modelReported: opts.modelReported,
      latencyMs: Date.now() - t0 + Math.floor(rng() * 30),
      surfaceKind: "api",
    },
  };
}

function empty(
  opts: { provider: string; modelReported: string },
  t0: number,
  code: string,
): EngineResponse {
  return {
    status: "error",
    errorCode: code,
    text: "",
    sources: [],
    fanouts: [],
    ads: [],
    products: [],
    maps: [],
    features: [],
    raw: { fixture: true, error: code },
    meta: {
      modelReported: opts.modelReported,
      latencyMs: Date.now() - t0,
      surfaceKind: "api",
    },
  };
}

function anyProviderKey(
  env: Record<string, string | undefined>,
): boolean {
  return Boolean(
    env.OPENAI_API_KEY ||
      env.PERPLEXITY_API_KEY ||
      env.ANTHROPIC_API_KEY ||
      env.GOOGLE_API_KEY ||
      env.GEMINI_API_KEY ||
      env.AZURE_OPENAI_API_KEY ||
      env.CURSOR_API_KEY ||
      env.OPENROUTER_API_KEY,
  );
}

export function resolveAdapterMode(
  env: Record<string, string | undefined> = process.env,
): "live" | "fixture" {
  if (env.GEO_ADAPTER_MODE === "fixture") return "fixture";
  if (env.GEO_ADAPTER_MODE === "live") {
    return anyProviderKey(env) ? "live" : "fixture";
  }
  return anyProviderKey(env) ? "live" : "fixture";
}

/**
 * Per-provider effective mode.
 * A missing key never fails the product — that channel stays on fixtures.
 */
export function resolveProviderMode(
  provider: ProviderId,
  env: Record<string, string | undefined> = process.env,
): "live" | "fixture" {
  if (env.GEO_ADAPTER_MODE === "fixture") return "fixture";
  if (!providerKeyPresent(provider, env)) return "fixture";
  if (env.GEO_ADAPTER_MODE === "live") return "live";
  return "live";
}

export function providerKeyPresent(
  provider: ProviderId,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (provider === "openai") return Boolean(env.OPENAI_API_KEY);
  if (provider === "perplexity") return Boolean(env.PERPLEXITY_API_KEY);
  if (provider === "anthropic") return Boolean(env.ANTHROPIC_API_KEY);
  if (provider === "google")
    return Boolean(env.GOOGLE_API_KEY || env.GEMINI_API_KEY);
  if (provider === "openrouter") return Boolean(env.OPENROUTER_API_KEY);
  // Copilot: optional Azure OpenAI; otherwise fixtures
  return Boolean(env.AZURE_OPENAI_API_KEY && env.AZURE_OPENAI_ENDPOINT);
}

/** Which provider API backs each model channel (Peec-like set, API-first). */
export const CHANNEL_PROVIDER_ROUTE: Record<
  string,
  { provider: ProviderId; note: string }
> = {
  "openai-0": {
    provider: "openai",
    note: "Legacy alias for OpenAI GPT + web search API. Not a ChatGPT UI observation.",
  },
  "openai-1": {
    provider: "openai",
    note: "Native OpenAI Responses API with web search; this is not the ChatGPT consumer UI.",
  },
  "perplexity-1": {
    provider: "perplexity",
    note: "Perplexity Agent API using the fast preset; the provider-returned model is saved per answer. This is not the Perplexity consumer UI.",
  },
  "openrouter-free-1": {
    provider: "openrouter",
    note: "OpenRouter Free Models Router API. OpenRouter selects a compatible free model and the returned model identity is saved per answer; this is not a consumer UI.",
  },
  "anthropic-1": {
    provider: "anthropic",
    note: "Native Anthropic Messages API with web search; this is not the Claude consumer UI.",
  },
  "google-3": {
    provider: "google",
    note: "Native Google Gemini API with Google Search grounding; this is not the Gemini or Google Search consumer UI.",
  },
};

/** Honest runtime map for Channels UI / ops — never imply live without a key. */
export function describeAdapterRuntime(
  env: Record<string, string | undefined> = process.env,
) {
  const providers: ProviderId[] = [
    "openai",
    "openrouter",
    "perplexity",
    "anthropic",
    "google",
    "copilot",
  ];
  const rows = providers.map((provider) => ({
    provider,
    key_present: providerKeyPresent(provider, env),
    mode: resolveProviderMode(provider, env),
  }));
  return {
    GEO_ADAPTER_MODE: env.GEO_ADAPTER_MODE ?? "auto",
    GEO_COLLECTION_BACKEND: env.GEO_COLLECTION_BACKEND ?? "auto",
    cursor_key_present: Boolean(env.CURSOR_API_KEY),
    openrouter_key_present: Boolean(env.OPENROUTER_API_KEY),
    global_resolved: resolveAdapterMode(env),
    providers: rows,
    channels: Object.entries(CHANNEL_PROVIDER_ROUTE).map(
      ([channel_id, route]) => {
        const backend = collectionBackendForProvider(route.provider, env);
        const nativeKeyPresent = providerKeyPresent(route.provider, env);
        const missingNative = !nativeKeyPresent;
        const via_openrouter =
          Boolean(env.OPENROUTER_API_KEY) &&
          (route.provider === "openrouter" ||
            backend === "openrouter" ||
            (backend === "auto" && missingNative)) &&
          env.GEO_ADAPTER_MODE !== "fixture";
        const via_cursor =
          Boolean(env.CURSOR_API_KEY) &&
          !via_openrouter &&
          (backend === "cursor" || (backend === "auto" && missingNative)) &&
          env.GEO_ADAPTER_MODE !== "fixture";
        const effectiveKeyPresent = nativeKeyPresent || via_openrouter || via_cursor;
        return {
          channel_id,
          provider: route.provider,
          collection_backend: backend,
          key_present: effectiveKeyPresent,
          native_key_present: nativeKeyPresent,
          mode:
            env.GEO_ADAPTER_MODE === "fixture" || !effectiveKeyPresent
              ? ("fixture" as const)
              : ("live" as const),
          surface_kind: "api" as const,
          route_note: via_openrouter
            ? route.provider === "openrouter"
              ? route.note
              : route.provider === "google"
              ? "OpenRouter chat completions using the configured Google-family model; this is not the native Gemini API, Google Search grounding, or a consumer UI."
              : `OpenRouter chat completions using the configured ${route.provider} model-family; this is not the native provider API or a consumer UI.`
            : via_cursor
              ? "Cursor model API route; this is not the native provider API or a consumer UI."
              : route.note,
          via_openrouter,
          via_cursor,
        };
      },
    ),
    routing_policy:
      "GEO_<PROVIDER>_COLLECTION_BACKEND can override one provider. OPENROUTER_API_KEY fills missing native keys in auto mode; CURSOR_API_KEY is the fallback.",
    honesty:
      "surface_kind is always api (or simulator). We do not scrape consumer UIs. OpenRouter/Cursor are multi-model text, not identical to consumer AI-search UIs.",
  };
}
