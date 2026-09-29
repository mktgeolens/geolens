import { CursorRoutedAdapter, shouldUseCursor } from "./api/cursor.js";
import { CHANNEL_PROVIDER_ROUTE } from "./api/fixtures.js";
import {
  OpenRouterRoutedAdapter,
  shouldUseOpenRouter,
} from "./api/openrouter.js";
import {
  AnthropicApiAdapter,
  CopilotApiAdapter,
  GoogleGeminiApiAdapter,
  OpenAiApiAdapter,
  PerplexityApiAdapter,
} from "./api/providers.js";
import { SimulatorAdapter } from "./simulator/index.js";
import type { EngineAdapter, EngineRequest, EngineResponse } from "./types.js";

const cache = new Map<string, EngineAdapter>();

/**
 * Wraps a provider adapter so Peec-labeled channels keep their own channelId
 * while running the correct model family (GPT / Claude / Gemini / …).
 */
class RoutedChannelAdapter implements EngineAdapter {
  readonly surfaceKind = "api" as const;

  constructor(
    readonly channelId: string,
    private readonly inner: EngineAdapter,
    private readonly routeNote: string,
  ) {}

  get capabilities() {
    return this.inner.capabilities;
  }

  health() {
    return this.inner.health();
  }

  async run(req: EngineRequest): Promise<EngineResponse> {
    const out = await this.inner.run({
      ...req,
      channelId: this.inner.channelId,
    });
    return {
      ...out,
      meta: {
        ...out.meta,
        surfaceKind: "api",
      },
      raw: {
        ...(typeof out.raw === "object" && out.raw ? out.raw : {}),
        routed_channel_id: this.channelId,
        provider_channel_id: this.inner.channelId,
        collection_note: this.routeNote,
      },
    };
  }
}

function buildProviderAdapter(provider: string): EngineAdapter {
  switch (provider) {
    case "openai":
      return new OpenAiApiAdapter();
    case "perplexity":
      return new PerplexityApiAdapter();
    case "anthropic":
      return new AnthropicApiAdapter();
    case "google":
      return new GoogleGeminiApiAdapter("google-3");
    case "copilot":
      return new CopilotApiAdapter();
    default:
      throw new Error(`no_provider_adapter:${provider}`);
  }
}

/** Resolve an adapter for a model channel id (API-first Peec routing). */
export function getAdapter(channelId: string): EngineAdapter {
  const cached = cache.get(channelId);
  if (cached) return cached;

  let adapter: EngineAdapter;
  if (channelId === "sim-0") {
    adapter = new SimulatorAdapter();
  } else {
    const route = CHANNEL_PROVIDER_ROUTE[channelId];
    if (!route) {
      throw new Error(`no_adapter_for_channel:${channelId}`);
    }
    // Prefer OpenRouter (fast chat completions), then Cursor, then native vendor APIs
    if (channelId === "openrouter-free-1") {
      adapter = new OpenRouterRoutedAdapter(channelId, route.provider);
    } else if (shouldUseOpenRouter(route.provider)) {
      adapter = new OpenRouterRoutedAdapter(channelId, route.provider);
    } else if (shouldUseCursor(route.provider)) {
      adapter = new CursorRoutedAdapter(channelId, route.provider);
    } else if (
      (route.provider === "openai" && channelId === "openai-1") ||
      (route.provider === "perplexity" && channelId === "perplexity-1") ||
      (route.provider === "anthropic" && channelId === "anthropic-1") ||
      (route.provider === "google" && channelId === "google-3") ||
      (route.provider === "copilot" && channelId === "copilot-1")
    ) {
      adapter = buildProviderAdapter(route.provider);
    } else {
      adapter = new RoutedChannelAdapter(
        channelId,
        buildProviderAdapter(route.provider),
        route.note,
      );
    }
  }

  cache.set(channelId, adapter);
  return adapter;
}

/**
 * Default set contains only API surfaces we actually query.
 */
export const DEFAULT_API_CHANNELS = [
  "openai-1",
  "perplexity-1",
  "google-3",
  "anthropic-1",
] as const;

/** Core live providers (also include Claude for Claude checks). */
export const CORE_PROVIDER_CHANNELS = [
  "openai-1",
  "anthropic-1",
  "perplexity-1",
  "google-3",
] as const;

export function listBuiltAdapters(): EngineAdapter[] {
  return [
    getAdapter("sim-0"),
    ...Object.keys(CHANNEL_PROVIDER_ROUTE).map((id) => getAdapter(id)),
  ];
}

export function clearAdapterCache() {
  cache.clear();
}
