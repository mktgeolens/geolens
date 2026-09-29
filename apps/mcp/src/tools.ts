import {
  brandsReportPayload,
  getDemoStore,
  loadProjectStore,
  createDb,
  hasDatabaseUrl,
  listBrands,
  adsFromStore,
  fanoutsFromStore,
  type DemoStore,
  type Db,
} from "@geo/db";
import { CHANNEL_PROVIDER_ROUTE, describeAdapterRuntime } from "@geo/adapters";

export const MCP_TOOLS = [
  "reports.brands",
  "projects.get",
  "chats.list",
  "brands.list",
  "prompts.list",
  "channels.routing",
  "reports.fanouts",
  "reports.ads",
] as const;

export type McpToolName = (typeof MCP_TOOLS)[number];

export const MCP_SLASH_COMMANDS = [
  {
    name: "visibility",
    description: "Show brand visibility for the current project",
    tool: "reports.brands" as const,
  },
  {
    name: "project",
    description: "Show project metadata",
    tool: "projects.get" as const,
  },
  {
    name: "routing",
    description: "Show which provider API backs each AI channel",
    tool: "channels.routing" as const,
  },
] as const;

export function listPlannedTools() {
  return MCP_TOOLS;
}

export function listSlashCommands() {
  return MCP_SLASH_COMMANDS;
}

async function resolveStore(
  projectId: string,
  db: Db | null,
): Promise<DemoStore | null> {
  if (db) {
    const fromPg = await loadProjectStore(db, projectId);
    if (fromPg) return fromPg;
  }
  const demo = await getDemoStore();
  if (demo.project.id === projectId) return demo;
  return null;
}

/**
 * MCP tool dispatcher — must use the same brandsReportPayload as API/dashboard.
 */
export async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
  opts?: { databaseUrl?: string },
): Promise<unknown> {
  const url =
    opts?.databaseUrl ??
    (hasDatabaseUrl() ? process.env.DATABASE_URL : undefined);
  const db = url ? createDb(url) : null;

  if (name === "reports.brands") {
    const projectId = String(args.project_id ?? "prj_demo");
    const store = await resolveStore(projectId, db);
    if (!store) throw new Error("project_not_found");
    const report = brandsReportPayload(store);
    return {
      data: report.rows,
      total_count: report.rows.length,
      formula: report.formula,
      meta: report.meta,
    };
  }

  if (name === "projects.get") {
    const projectId = String(args.project_id ?? "prj_demo");
    const store = await resolveStore(projectId, db);
    if (!store) throw new Error("project_not_found");
    return {
      project: store.project,
      brands: store.brands.map((b) => ({
        id: b.id,
        name: b.name,
        is_own: b.is_own,
      })),
    };
  }

  if (name === "chats.list") {
    const projectId = String(args.project_id ?? "prj_demo");
    const limit = Math.min(Number(args.limit ?? 20), 100);
    const store = await resolveStore(projectId, db);
    if (!store) throw new Error("project_not_found");
    return {
      rows: store.chats.slice(0, limit).map((c) => ({
        id: c.id,
        run_date: c.run_date,
        model_channel_id: c.model_channel_id,
        surface_kind: c.surface_kind,
        status: c.status,
        country_code: c.country_code,
      })),
    };
  }

  if (name === "brands.list") {
    const projectId = String(args.project_id ?? "prj_demo");
    const store = await resolveStore(projectId, db);
    if (!store) throw new Error("project_not_found");
    return { rows: listBrands(store) };
  }

  if (name === "prompts.list") {
    const projectId = String(args.project_id ?? "prj_demo");
    const store = await resolveStore(projectId, db);
    if (!store) throw new Error("project_not_found");
    return { rows: store.prompts };
  }

  if (name === "channels.routing") {
    const runtime = describeAdapterRuntime();
    return {
      policy:
        "API observations only. Effective providers, intermediaries, and model identities are reported from runtime routing and saved answer provenance; no channel represents a consumer UI.",
      routes: CHANNEL_PROVIDER_ROUTE,
      runtime,
    };
  }

  if (name === "reports.fanouts") {
    const projectId = String(args.project_id ?? "prj_demo");
    const store = await resolveStore(projectId, db);
    if (!store) throw new Error("project_not_found");
    return fanoutsFromStore(store);
  }

  if (name === "reports.ads") {
    const projectId = String(args.project_id ?? "prj_demo");
    const store = await resolveStore(projectId, db);
    if (!store) throw new Error("project_not_found");
    return adsFromStore(store);
  }

  throw new Error(`unknown_tool:${name}`);
}
