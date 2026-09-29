import {
  checkCollect,
  closeDb,
  createDb,
  deliverDueReports,
  ensureCommercial,
  loadProjectStore,
  project as projectTable,
} from "@geo/db";
import { getChannel } from "@geo/registry";
import { enqueueAnalyzeProject } from "./analyzeQueue.js";
import { queueMode } from "./queue.js";
import { snapshotProjectCollect } from "./schedule.js";

function dateInTimezone(now: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function projectCollectionIsDue(input: {
  frequency: string;
  runDate: string;
  latestRunDate?: string;
}): boolean {
  if (!input.latestRunDate) return true;
  if (input.latestRunDate >= input.runDate) return false;
  if (input.frequency !== "weekly") return true;
  const current = Date.parse(`${input.runDate}T00:00:00Z`);
  const latest = Date.parse(`${input.latestRunDate}T00:00:00Z`);
  if (!Number.isFinite(current) || !Number.isFinite(latest)) return false;
  return current - latest >= 7 * 24 * 60 * 60_000;
}

function schedulerIntervalMs(): number {
  const configured = Number(process.env.GEO_SCHEDULER_INTERVAL_MS ?? 15 * 60_000);
  if (!Number.isFinite(configured)) return 15 * 60_000;
  return Math.max(60_000, Math.round(configured));
}

export async function runProjectSchedulerTick(
  now = new Date(),
): Promise<{ scanned: number; queued: number }> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || queueMode() !== "bullmq") return { scanned: 0, queued: 0 };
  const db = createDb(databaseUrl);
  try {
  await deliverDueReports(db);
  const projects = await db.select().from(projectTable);
  let queued = 0;

  for (const project of projects) {
    if (
      project.status === "PAUSED" ||
      !project.domain ||
      (project.frequency !== "daily" && project.frequency !== "weekly")
    ) {
      continue;
    }
    const store = await loadProjectStore(db, project.id);
    if (!store?.prompts.some((prompt) => prompt.status === "active")) {
      continue;
    }
    const quota = checkCollect(store);
    if (!quota.ok) continue;
    const channelIds = ensureCommercial(store).enabled_channel_ids.filter(
      (channelId) => getChannel(channelId)?.surface === "api",
    );
    if (channelIds.length === 0) continue;
    const runDate = dateInTimezone(
      now,
      project.timezone || store.organization.timezone || "UTC",
    );
    const latestRunDate = store.chats
      .map((chat) => chat.run_date)
      .sort((a, b) => b.localeCompare(a))[0];
    if (
      !projectCollectionIsDue({
        frequency: project.frequency,
        runDate,
        latestRunDate,
      })
    ) {
      continue;
    }
    const ownBrand = store.brands.find((brand) => brand.is_own);
    const jobId = `sched_${project.id}_${runDate.replaceAll("-", "")}`;
    await enqueueAnalyzeProject({
      job_id: jobId,
      snapshot: snapshotProjectCollect(store, { channelIds, runDate, observationId: jobId, seed: `scheduled|${project.id}|${runDate}` }),
      project_id: project.id,
      domain: project.domain,
      brand_name: ownBrand?.name ?? project.name,
      prompts_activated: 0,
      channel_ids: channelIds,
      concurrency: 2,
      seed: `scheduled|${project.id}|${runDate}`,
      run_date: runDate,
      started_at: now.toISOString(),
    });
    queued += 1;
  }
  return { scanned: projects.length, queued };
  } finally { await closeDb(db); }
}

export async function startProjectScheduler(): Promise<{
  close: () => Promise<void>;
}> {
  if (!process.env.DATABASE_URL || queueMode() !== "bullmq") {
    return { close: async () => undefined };
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runProjectSchedulerTick();
      if (result.queued > 0) {
        console.log(
          `Scheduled ${result.queued} analysis job(s) from ${result.scanned} project(s)`,
        );
      }
    } catch (error) {
      console.error("Project scheduler tick failed", error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), schedulerIntervalMs());
  timer.unref?.();
  void tick();
  return { close: async () => clearInterval(timer) };
}
