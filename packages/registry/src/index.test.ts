import { describe, expect, it } from "vitest";
import {
  channelSupportsCountry,
  getChannel,
  listApiChannels,
  MODEL_CHANNELS,
} from "./index.js";

describe("MODEL_CHANNELS", () => {
  it("includes the simulator channel", () => {
    expect(getChannel("sim-0")?.surface).toBe("simulator");
  });

  it("has unique channel ids", () => {
    const ids = MODEL_CHANNELS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lists only the API surfaces actually collected", () => {
    const api = listApiChannels();
    expect(api.map((c) => c.id).sort()).toEqual(
      [
        "anthropic-1",
        "google-3",
        "openai-1",
        "openrouter-free-1",
        "perplexity-1",
      ],
    );
    expect(getChannel("google-ai-mode")).toBeUndefined();
    expect(getChannel("google-ai-overviews")).toBeUndefined();
    expect(getChannel("copilot-1")).toBeUndefined();
    for (const c of api) {
      expect(c.versionHistory.length).toBeGreaterThan(0);
      expect(c.geoCapability).toBeTruthy();
      expect(c.description).not.toMatch(/consumer UI/i);
    }
    expect(getChannel("perplexity-1")?.description).toBe(
      "Perplexity Agent API",
    );
    expect(getChannel("perplexity-1")?.currentModel).toBe(
      "perplexity-agent-fast",
    );
    expect(getChannel("openrouter-free-1")?.description).toBe(
      "OpenRouter Free Models Router API",
    );
  });

  it("respects unsupported countries", () => {
    expect(channelSupportsCountry("openai-1", "US")).toBe(true);
  });
});
