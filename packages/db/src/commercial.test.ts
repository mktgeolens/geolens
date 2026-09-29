import { describe, expect, it } from "vitest";
import {
  checkPromptActivation,
  commercialSummary,
  convertPitchToCustomer,
  gdprDeleteProjectData,
  gdprExportProject,
  ingestBotVisit,
  pauseProject,
  setEnabledChannels,
  setOrgPlan,
  unpauseProject,
} from "./commercial.js";
import { getDemoStore, resetDemoStore } from "./seed.js";

describe("Phase 11 commercial", () => {
  it("enforces trial prompt quota and pause semantics", async () => {
    resetDemoStore();
    const store = await getDemoStore();
    setOrgPlan(store, "trial");
    // Cap trial at 10 — pad active prompts to the limit
    while (
      store.prompts.filter((p) => p.status === "active").length < 10
    ) {
      store.prompts.push({
        id: `pr_fill_${store.prompts.length}`,
        project_id: store.project.id,
        text: `filler ${store.prompts.length}`,
        country_code: "US",
        status: "active",
      });
    }
    expect(checkPromptActivation(store).ok).toBe(false);
    expect(checkPromptActivation(store).code).toBe("prompt_quota");

    const denied = pauseProject(store, { acknowledge_data_loss: false });
    expect(denied.code).toBe("ack_required");
    expect(pauseProject(store, { acknowledge_data_loss: true }).ok).toBe(true);
    expect(store.project.status).toBe("PAUSED");
    expect(checkPromptActivation(store).code).toBe("project_paused");
    expect(unpauseProject(store).ok).toBe(true);
    expect(store.project.status).toBe("CUSTOMER");
  });

  it("converts pitch projects and exports GDPR package", async () => {
    resetDemoStore();
    const store = await getDemoStore();
    store.project.status = "PITCH";
    expect(convertPitchToCustomer(store).ok).toBe(true);
    expect(store.project.status).toBe("CUSTOMER");

    const exp = gdprExportProject(store);
    expect(exp.organization.id).toBe(store.organization.id);
    expect(exp.audit_log.length).toBeGreaterThan(0);

    const summary = commercialSummary(store);
    expect(summary.plan.code).toBeTruthy();
    expect(summary.pause.warning).toMatch(/permanently loses/i);
  });

  it("bot visit quota surfaces limit-reached semantics", async () => {
    resetDemoStore();
    const store = await getDemoStore();
    setOrgPlan(store, "trial");
    store.commercial = {
      enabled_channel_ids: ["openai-1"],
      countries: ["US"],
      bot_visits_used: 99_999,
      credits_total: null,
      project_count: 1,
    };
    expect(ingestBotVisit(store, 1).ok).toBe(true);
    expect(ingestBotVisit(store, 1).code).toBe("bot_visit_quota");
    expect(commercialSummary(store).banners.bot_quota_exhausted).toBe(true);

    gdprDeleteProjectData(store);
    expect(store.user.email).toMatch(/^deleted\+/);
    expect(store.chats.length).toBe(0);
  });

  it("rejects retired or unknown collection channels", async () => {
    resetDemoStore();
    const store = await getDemoStore();
    store.commercial = {
      enabled_channel_ids: ["perplexity-1"],
      countries: ["IN"],
      bot_visits_used: 0,
      credits_total: null,
      project_count: 1,
    };
    const decision = setEnabledChannels(store, [
      "perplexity-1",
      "google-ai-overviews",
    ]);
    expect(decision).toMatchObject({ ok: false, code: "unknown_channel" });
    expect(store.commercial.enabled_channel_ids).toEqual(["perplexity-1"]);
  });
});
