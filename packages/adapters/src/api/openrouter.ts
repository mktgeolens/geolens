import type {
  EngineAdapter,
  EngineRequest,
  EngineResponse,
} from "../types.js";
import type { ProviderId } from "./fixtures.js";
import { collectionBackendForProvider, fixtureEngineResponse, resolveProviderMode } from "./fixtures.js";

/**
 * Map GeoLens channels → OpenRouter model ids.
 * Override via OPENROUTER_MODEL_OPENAI / OPENROUTER_MODEL_ANTHROPIC / etc.
 */
export function openRouterModelForChannel(
  channelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (channelId === "openrouter-free-1") {
    return env.OPENROUTER_MODEL_FREE ?? "openrouter/free";
  }
  if (channelId.startsWith("openai") || channelId === "copilot-1") {
    return (
      env.OPENROUTER_MODEL_OPENAI ??
      env.OPENROUTER_MODEL_GPT ??
      "openai/gpt-4o-mini"
    );
  }
  if (channelId.startsWith("anthropic")) {
    return (
      env.OPENROUTER_MODEL_ANTHROPIC ??
      env.OPENROUTER_MODEL_CLAUDE ??
      "anthropic/claude-3.5-sonnet"
    );
  }
  if (channelId.startsWith("google")) {
    return (
      env.OPENROUTER_MODEL_GOOGLE ??
      env.OPENROUTER_MODEL_GEMINI ??
      "google/gemini-2.5-flash"
    );
  }
  if (channelId.startsWith("perplexity")) {
    return (
      env.OPENROUTER_MODEL_PERPLEXITY ??
      "perplexity/sonar"
    );
  }
  return env.OPENROUTER_MODEL_DEFAULT ?? "openai/gpt-4o-mini";
}

export function openRouterKeyPresent(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(env.OPENROUTER_API_KEY);
}

/** Keep provider context limits from becoming unexpectedly large output budgets. */
export function openRouterMaxTokens(
  env: Record<string, string | undefined> = process.env,
  channelId?: string,
): number {
  const defaultBudget = channelId === "openrouter-free-1" ? 600 : 1200;
  const configured = Number.parseInt(
    channelId === "openrouter-free-1"
      ? (env.OPENROUTER_FREE_MAX_TOKENS ?? String(defaultBudget))
      : (env.OPENROUTER_MAX_TOKENS ?? String(defaultBudget)),
    10,
  );
  if (!Number.isFinite(configured)) return defaultBudget;
  return Math.max(128, Math.min(configured, 4096));
}

/**
 * Use OpenRouter when:
 * - GEO_COLLECTION_BACKEND=openrouter, or
 * - GEO_COLLECTION_BACKEND=auto (default) and native provider key is missing
 * Prefer OpenRouter over Cursor when both keys exist (faster chat completions).
 */
export function shouldUseOpenRouter(
  provider: ProviderId,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!openRouterKeyPresent(env)) return false;
  if (env.GEO_ADAPTER_MODE === "fixture") return false;
  if (provider === "openrouter") return true;
  const backend = collectionBackendForProvider(provider, env);
  if (backend === "native" || backend === "cursor") return false;
  if (backend === "openrouter") return true;
  // auto: fill channels missing a native vendor key
  return resolveProviderMode(provider, env) === "fixture";
}

function countryLabel(code: string): string {
  const c = (code || "US").toUpperCase();
  if (c === "IN") return "India";
  if (c === "GB" || c === "UK") return "the United Kingdom";
  if (c === "DE") return "Germany";
  if (c === "AU") return "Australia";
  if (c === "CA") return "Canada";
  if (c === "SG") return "Singapore";
  if (c === "AE") return "the United Arab Emirates";
  if (c === "US") return "the United States";
  return c;
}

function extractMessageText(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const choices = (raw as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const msg = (choices[0] as { message?: { content?: unknown } })?.message;
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * OpenRouter chat completions — one key for multi-model routing.
 */
export class OpenRouterRoutedAdapter implements EngineAdapter {
  readonly surfaceKind = "api" as const;
  readonly capabilities = {
    fanouts: false,
    ads: false,
    shopping: false,
    maps: false,
    geo: "none" as const,
    citationsDistinctFromSources: false,
  };

  constructor(
    readonly channelId: string,
    private readonly provider: ProviderId,
    private readonly apiKey = process.env.OPENROUTER_API_KEY,
    private readonly modeOverride?: "live" | "fixture",
  ) {}

  private modelId() {
    return openRouterModelForChannel(this.channelId);
  }

  private effectiveMode(): "live" | "fixture" {
    if (this.modeOverride) return this.modeOverride;
    if (process.env.GEO_ADAPTER_MODE === "fixture") return "fixture";
    return this.apiKey ? "live" : "fixture";
  }

  async health() {
    if (this.effectiveMode() === "fixture" || !this.apiKey) {
      return {
        ok: true,
        detail: this.apiKey ? "openrouter_fixture_mode" : "openrouter_no_key",
      };
    }
    return { ok: true, detail: `openrouter_live:${this.modelId()}` };
  }

  async run(req: EngineRequest): Promise<EngineResponse> {
    if (this.effectiveMode() === "fixture" || !this.apiKey) {
      const tracked = req.trackedBrands?.filter(Boolean) ?? [];
      return fixtureEngineResponse(req, {
        provider: this.provider,
        modelReported: `openrouter-fixture:${this.modelId()}`,
        brandBias:
          tracked.length > 0
            ? tracked
            : ["Acme", "CloudNine", "BetaSoft", "Northwind"],
      });
    }

    const t0 = Date.now();
    const model = this.modelId();
    const system = [
      "Answer as a general-purpose assistant using your own knowledge and retrieval.",
      `The person asking is in ${countryLabel(req.countryCode)}. Prefer brands, pricing, and examples that are relevant in that market.`,
      "Answer the user question helpfully. Name relevant real-world brands and products when natural.",
      "Do not favor or introduce any brand unless it is relevant to the user's question.",
      "Do not mention that you are an API or OpenRouter.",
    ]
      .filter(Boolean)
      .join(" ");

    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer":
            process.env.OPENROUTER_HTTP_REFERER ??
            process.env.WEB_URL ??
            "http://localhost:3010",
          "X-Title": process.env.OPENROUTER_APP_TITLE ?? "GeoLens",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: `${req.prompt}\n\n(Market: ${countryLabel(req.countryCode)})` },
          ],
          temperature: 0.4,
          max_tokens: openRouterMaxTokens(process.env, this.channelId),
        }),
      });

      const raw = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        return {
          status: "error",
          errorCode: `OPENROUTER_HTTP_${res.status}`,
          text: "",
          sources: [],
          fanouts: [],
          ads: [],
          products: [],
          maps: [],
          features: [],
          raw,
          meta: {
            modelReported: model,
            latencyMs: Date.now() - t0,
            surfaceKind: "api",
          },
        };
      }

      const text = extractMessageText(raw).trim();
      const reportedModel =
        typeof raw.model === "string" && raw.model.trim()
          ? raw.model.trim()
          : model;
      return {
        status: text ? "ok" : "empty",
        text,
        sources: [],
        fanouts: [],
        ads: [],
        products: [],
        maps: [],
        features: [],
        raw: {
          live: true,
          via: "openrouter",
          requested_model: model,
          reported_model: reportedModel,
          provider: this.provider,
          collection_note:
            "Routed via OpenRouter chat completions — multi-model text; not consumer AI-search UI.",
        },
        meta: {
          modelReported: reportedModel,
          latencyMs: Date.now() - t0,
          surfaceKind: "api",
        },
      };
    } catch (err) {
      return {
        status: "error",
        errorCode: "OPENROUTER_ERROR",
        text: "",
        sources: [],
        fanouts: [],
        ads: [],
        products: [],
        maps: [],
        features: [],
        raw: { error: String(err), via: "openrouter", model },
        meta: {
          modelReported: model,
          latencyMs: Date.now() - t0,
          surfaceKind: "api",
        },
      };
    }
  }
}
