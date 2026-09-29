export type SurfaceKind = "ui" | "api" | "simulator";

export interface ModelChannelVersion {
  modelId: string;
  /** ISO date when this model became current for the channel. */
  effectiveFrom: string;
  note?: string;
}

export interface ModelChannel {
  id: string;
  description: string;
  surface: SurfaceKind;
  /** Stable provider key for rate limiting / credentials. */
  provider: string;
  currentModel: string;
  /** Model upgrades that must not fragment reporting history. */
  versionHistory: ModelChannelVersion[];
  supportsFanouts: boolean;
  supportsAds: boolean;
  supportsShopping: boolean;
  /** Prompt countries that produce no chat (§6.1). */
  unsupportedCountryCodes: string[];
  /** UI honesty: most APIs ignore geography. */
  geoCapability: "full" | "partial" | "none";
}

/**
 * Truthful collection channels. A channel names the API surface actually
 * queried, never a consumer product that merely uses a related model.
 */
export const MODEL_CHANNELS: ModelChannel[] = [
  {
    id: "sim-0",
    description: "Simulator (dev/demo)",
    surface: "simulator",
    provider: "simulator",
    currentModel: "simulator-v1",
    versionHistory: [
      { modelId: "simulator-v1", effectiveFrom: "2025-01-01" },
    ],
    supportsFanouts: true,
    supportsAds: true,
    supportsShopping: true,
    unsupportedCountryCodes: [],
    geoCapability: "full",
  },
  {
    id: "openai-1",
    description: "OpenAI-family API channel",
    surface: "api",
    provider: "openai",
    currentModel: "gpt-web-search",
    versionHistory: [
      {
        modelId: "gpt-4o-search-preview",
        effectiveFrom: "2025-01-01",
        note: "retired",
      },
      { modelId: "gpt-web-search", effectiveFrom: "2025-06-01" },
    ],
    supportsFanouts: true,
    supportsAds: false,
    supportsShopping: false,
    unsupportedCountryCodes: [],
    geoCapability: "none",
  },
  {
    id: "perplexity-1",
    description: "Perplexity Agent API",
    surface: "api",
    provider: "perplexity",
    currentModel: "perplexity-agent-fast",
    versionHistory: [
      { modelId: "sonar", effectiveFrom: "2025-01-01", note: "retired" },
      {
        modelId: "perplexity-agent-fast",
        effectiveFrom: "2026-09-25",
        note: "Agent API fast preset; the provider-returned model is saved per answer",
      },
    ],
    supportsFanouts: true,
    supportsAds: false,
    supportsShopping: false,
    unsupportedCountryCodes: [],
    geoCapability: "none",
  },
  {
    id: "openrouter-free-1",
    description: "OpenRouter Free Models Router API",
    surface: "api",
    provider: "openrouter",
    currentModel: "openrouter/free",
    versionHistory: [
      {
        modelId: "openrouter/free",
        effectiveFrom: "2026-09-29",
        note: "OpenRouter selects a compatible free model; the provider-returned model is saved per answer",
      },
    ],
    supportsFanouts: false,
    supportsAds: false,
    supportsShopping: false,
    unsupportedCountryCodes: [],
    geoCapability: "none",
  },
  {
    id: "anthropic-1",
    description: "Anthropic-family API channel",
    surface: "api",
    provider: "anthropic",
    currentModel: "claude-web-search",
    versionHistory: [
      { modelId: "claude-web-search", effectiveFrom: "2025-03-01" },
    ],
    supportsFanouts: true,
    supportsAds: false,
    supportsShopping: false,
    unsupportedCountryCodes: [],
    geoCapability: "none",
  },
  {
    id: "google-3",
    description: "Google-family API channel",
    surface: "api",
    provider: "google",
    currentModel: "gemini-grounded",
    versionHistory: [
      { modelId: "gemini-grounded", effectiveFrom: "2025-01-01" },
    ],
    supportsFanouts: true,
    supportsAds: false,
    supportsShopping: false,
    unsupportedCountryCodes: [],
    geoCapability: "none",
  },
];

export function getChannel(id: string): ModelChannel | undefined {
  return MODEL_CHANNELS.find((c) => c.id === id);
}

export function listApiChannels(): ModelChannel[] {
  return MODEL_CHANNELS.filter((c) => c.surface === "api");
}

export function channelSupportsCountry(
  channelId: string,
  countryCode: string,
): boolean {
  const ch = getChannel(channelId);
  if (!ch) return false;
  return !ch.unsupportedCountryCodes.includes(countryCode.toUpperCase());
}

export const COUNTRIES = [
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "DE", name: "Germany" },
  { code: "IN", name: "India" },
  { code: "AU", name: "Australia" },
] as const;

export * from "./assistants.js";
export * from "./bots.js";
