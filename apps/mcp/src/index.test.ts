import { describe, expect, it } from "vitest";
import { brandsReportPayload, getDemoStore, resetDemoStore } from "@geo/db";
import { callMcpTool, listPlannedTools, listSlashCommands } from "./index.js";

describe("MCP Phase 10", () => {
  it("lists tools and slash commands", () => {
    expect(listPlannedTools()).toContain("reports.brands");
    expect(listSlashCommands().some((c) => c.tool === "reports.brands")).toBe(
      true,
    );
  });

  it("reports.brands matches dashboard brandsReportPayload (parity)", async () => {
    delete process.env.DATABASE_URL;
    resetDemoStore();
    const store = await getDemoStore();
    const dash = brandsReportPayload(store);
    const mcp = (await callMcpTool("reports.brands", {
      project_id: store.project.id,
    })) as { data: typeof dash.rows };

    expect(mcp.data.length).toBe(dash.rows.length);
    for (let i = 0; i < dash.rows.length; i++) {
      expect(mcp.data[i]!.brand_id).toBe(dash.rows[i]!.brand_id);
      expect(mcp.data[i]!.visibility).toBe(dash.rows[i]!.visibility);
      expect(mcp.data[i]!.share_of_voice).toBe(dash.rows[i]!.share_of_voice);
      expect(mcp.data[i]!.mention_count).toBe(dash.rows[i]!.mention_count);
    }
  }, 60_000);

  it("reports effective API routing without claiming consumer UI collection", async () => {
    const routing = (await callMcpTool("channels.routing", {})) as {
      policy: string;
      runtime: { channels: { channel_id: string; route_note: string }[] };
    };

    expect(routing.policy).toMatch(/no channel represents a consumer UI/i);
    expect(routing.runtime.channels.length).toBeGreaterThanOrEqual(4);
    expect(
      routing.runtime.channels.every((channel) => channel.route_note.length > 0),
    ).toBe(true);
  });
});
