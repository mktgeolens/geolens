import { createHash } from "node:crypto";
import { classifyBranding, compareBrandRank } from "@geo/core";
import { analysisScopedActivePrompts } from "./promptIdentity.js";
import type { DemoStore } from "./seed.js";
import { metricsFromStore } from "./seed.js";

/** Canonical brands report — dashboard, API, MCP, CSV must call this. */
export function brandsReportPayload(store: DemoStore) {
  const rows = metricsFromStore(store).sort(
    (a, b) => b.visibility - a.visibility,
  );
  return {
    project_id: store.project.id,
    formula: {
      visibility: "visibility_count / visibility_total",
      share_of_voice: "brand_mentions / all_brand_mentions",
      position: "mean position among chats where brand appears",
      sentiment: "mean sentiment among chats where brand appears",
    },
    filters_vs_having:
      "filters shrink the chat set before aggregation; having filters metric rows after.",
    pitfalls: [
      "Empty/error chats do not depress visibility denominators.",
      "SoV collapses when the brand set changes — compare like-for-like windows.",
    ],
    rows,
    meta: {
      chats: store.chats.length,
      additive: true,
      rollup_watermark: new Date().toISOString(),
    },
  };
}

export function brandsReportCsv(store: DemoStore): string {
  const { rows } = brandsReportPayload(store);
  const header = [
    "brand_id",
    "brand_name",
    "is_own",
    "visibility",
    "share_of_voice",
    "position",
    "sentiment",
    "mention_count",
  ].join(",");
  const lines = rows.map((r) =>
    [
      r.brand_id,
      csvEscape(r.brand_name),
      r.is_own ? "1" : "0",
      r.visibility,
      r.share_of_voice,
      r.position ?? "",
      r.sentiment ?? "",
      r.mention_count,
    ].join(","),
  );
  return [header, ...lines].join("\n");
}

export function chatsReportCsv(store: DemoStore, limit = 5000): string {
  const header = [
    "chat_id",
    "run_date",
    "country_code",
    "model_channel_id",
    "surface_kind",
    "status",
    "prompt_id",
    "prompt_text",
    "brand_mentions",
  ].join(",");
  const promptById = new Map(store.prompts.map((p) => [p.id, p]));
  const lines = store.chats.slice(0, limit).map((c) => {
    const mentions = store.mentions
      .filter((m) => m.chat_id === c.id)
      .map((m) => {
        const b = store.brands.find((x) => x.id === m.brand_id);
        return b?.name ?? m.brand_id;
      })
      .join("|");
    return [
      c.id,
      c.run_date,
      c.country_code,
      c.model_channel_id,
      c.surface_kind ?? "",
      c.status,
      c.prompt_id,
      csvEscape(promptById.get(c.prompt_id)?.text ?? ""),
      csvEscape(mentions),
    ].join(",");
  });
  return [header, ...lines].join("\n");
}

function csvEscape(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Flat BI connector schema (§13). */
export function biBrandsFlat(store: DemoStore) {
  const { rows, meta } = brandsReportPayload(store);
  return {
    schema: "geo_bi_brands_v1",
    project_id: store.project.id,
    generated_at: meta.rollup_watermark,
    data: rows.map((r) => ({
      project_id: store.project.id,
      brand_id: r.brand_id,
      brand_name: r.brand_name,
      is_own: r.is_own,
      visibility: r.visibility,
      share_of_voice: r.share_of_voice,
      position: r.position,
      sentiment: r.sentiment,
      mention_count: r.mention_count,
    })),
  };
}

export const OVERVIEW_RANGES = ["7d", "30d", "90d"] as const;
export type OverviewRange = (typeof OVERVIEW_RANGES)[number];

export type OverviewFilterInput = {
  range?: string | null;
  channel?: string | null;
};

export function parseOverviewFilters(input: OverviewFilterInput = {}): {
  range: OverviewRange;
  channel: string | null;
} {
  const range = OVERVIEW_RANGES.includes(input.range as OverviewRange)
    ? (input.range as OverviewRange)
    : "7d";
  const raw = input.channel?.trim();
  const channel = !raw || raw === "all" ? null : raw;
  return { range, channel };
}

function overviewRangeDays(range: OverviewRange): number {
  if (range === "90d") return 90;
  if (range === "30d") return 30;
  return 7;
}

function overviewWindow(
  chats: DemoStore["chats"],
  range: OverviewRange,
): { from: string; to: string } {
  const days = overviewRangeDays(range);
  const latest = chats.reduce((max, c) => {
    const day = c.run_date.slice(0, 10);
    return day > max ? day : max;
  }, "");
  const to = latest || new Date().toISOString().slice(0, 10);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  const from = new Date(toMs - (days - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return { from, to };
}

function sliceOverviewStore(
  store: DemoStore,
  from: string,
  to: string,
  channel: string | null,
  promptIds?: Set<string>,
): DemoStore {
  const chats = store.chats.filter((c) => {
    const day = c.run_date.slice(0, 10);
    if (day < from || day > to) return false;
    if (channel && c.model_channel_id !== channel) return false;
    if (promptIds && !promptIds.has(c.prompt_id)) return false;
    return true;
  });
  const chatIds = new Set(chats.map((c) => c.id));
  return {
    ...store,
    chats,
    mentions: store.mentions.filter((m) => chatIds.has(m.chat_id)),
    sources: store.sources.filter((s) => chatIds.has(s.chat_id)),
  };
}

export type OverviewReport = ReturnType<typeof overviewReportPayload>;

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

/** Visibility Overview aggregate with an inspectable, sample-aware score. */
export function overviewReportPayload(
  store: DemoStore,
  filters: OverviewFilterInput = {},
) {
  const parsed = parseOverviewFilters(filters);
  const { from, to } = overviewWindow(store.chats, parsed.range);
  const analysisScope = store.analysisScope;
  let scopedBrandIds: Set<string> | null = null;
  if (analysisScope && analysisScope.domain === store.project.domain) {
    scopedBrandIds = new Set(analysisScope.brandIds);
  }
  const scopedBrands = scopedBrandIds
    ? store.brands.filter((brand) => scopedBrandIds.has(brand.id))
    : store.brands;
  const reportStore = { ...store, brands: scopedBrands };
  const ownBrandConfig =
    scopedBrands.find((brand) => brand.is_own) ?? scopedBrands[0];
  const activePrompts = analysisScopedActivePrompts(store);
  const activePromptIds = new Set(activePrompts.map((prompt) => prompt.id));
  const scorePrompts = activePrompts.filter(
    (prompt) =>
      (prompt.branding ??
        classifyBranding(prompt.text, ownBrandConfig?.name ?? "")) ===
      "non-branded",
  );
  const scorePromptIds = new Set(scorePrompts.map((prompt) => prompt.id));
  const view = sliceOverviewStore(
    reportStore,
    from,
    to,
    parsed.channel,
    activePromptIds,
  );
  const scoreView = sliceOverviewStore(
    reportStore,
    from,
    to,
    parsed.channel,
    scorePromptIds,
  );
  const brands = brandsReportPayload(scoreView);
  const own = brands.rows.find((r) => r.is_own) ?? brands.rows[0];
  const ranked = [...brands.rows].sort(compareBrandRank);
  const ownRank =
    own != null
      ? ranked.findIndex((r) => r.brand_id === own.brand_id) + 1
      : null;

  const eligibleChats = own?.visibility_total ?? 0;
  const eligibleChatIds = new Set(scoreView.chats.filter((chat) => chat.status === "ok" || chat.status === "empty").map((chat) => chat.id));
  const ownMentionedChatIds = new Set(
    own
      ? scoreView.mentions
          .filter((m) => m.brand_id === own.brand_id && m.mention_count > 0 && eligibleChatIds.has(m.chat_id))
          .map((m) => m.chat_id)
      : [],
  );

  const byChannel = new Map<
    string,
    { chats: number; ok: number; mentioned: Set<string>; models: Set<string> }
  >();
  for (const c of scoreView.chats) {
    const cur = byChannel.get(c.model_channel_id) ?? {
      chats: 0,
      ok: 0,
      mentioned: new Set<string>(),
      models: new Set<string>(),
    };
    cur.chats += 1;
    if (c.status === "ok" || c.status === "empty") cur.ok += 1;
    if (c.model_reported) cur.models.add(c.model_reported);
    byChannel.set(c.model_channel_id, cur);
  }
  if (own) {
    for (const m of scoreView.mentions) {
      if (m.brand_id !== own.brand_id) continue;
      const chat = scoreView.chats.find((c) => c.id === m.chat_id);
      if (!chat) continue;
      const cur = byChannel.get(chat.model_channel_id);
      if (cur) cur.mentioned.add(chat.id);
    }
  }
  const channelRows = [...byChannel.entries()]
    .map(([channel_id, v]) => ({
      channel_id,
      label: channel_id.split("-")[0] ?? channel_id,
      chat_count: v.chats,
      mention_count: v.mentioned.size,
      visibility: v.ok === 0 ? 0 : v.mentioned.size / v.ok,
      models_reported: [...v.models].sort(),
    }))
    .sort((a, b) => b.mention_count - a.mention_count);

  const mentionTotal = channelRows.reduce((s, r) => s + r.mention_count, 0);
  const channels = channelRows.map((r) => ({
    ...r,
    share: mentionTotal === 0 ? 0 : r.mention_count / mentionTotal,
  }));

  const byCountry = new Map<
    string,
    { attempts: number; eligible: number; mentioned: Set<string> }
  >();
  for (const c of scoreView.chats) {
    const code = (c.country_code || "XX").toUpperCase();
    const row = byCountry.get(code) ?? {
      attempts: 0,
      eligible: 0,
      mentioned: new Set<string>(),
    };
    row.attempts += 1;
    if (c.status === "ok" || c.status === "empty") row.eligible += 1;
    if (ownMentionedChatIds.has(c.id)) row.mentioned.add(c.id);
    byCountry.set(code, row);
  }
  const countries = [...byCountry.entries()]
    .map(([code, row]) => ({
      code,
      count: row.attempts,
      attempt_count: row.attempts,
      eligible_answers: row.eligible,
      mentioned_answers: row.mentioned.size,
      presence: row.eligible === 0 ? 0 : row.mentioned.size / row.eligible,
    }))
    .sort(
      (a, b) =>
        b.presence - a.presence || b.eligible_answers - a.eligible_answers,
    );
  const scoreCountryCount = new Set(
    scoreView.chats.map((chat) => (chat.country_code || "XX").toUpperCase()),
  ).size;

  // GeoLens Visibility Score (0-100). This is a transparent evidence score,
  // not a claim to reproduce a proprietary third-party index. The point score
  // uses only observed evidence; uncertainty belongs in the interval/confidence.
  const mentionedAnswers = ownMentionedChatIds.size;
  const adjustedPresence =
    eligibleChats > 0 ? mentionedAnswers / eligibleChats : 0;
  const shareOfVoice = clamp01(own?.share_of_voice ?? 0);
  const positionQuality =
    own?.position == null ? 0 : clamp01(1 - (own.position - 1) / 9);
  const citedMentionedChats = new Set(
    scoreView.sources
      .filter((s) => {
        if (!s.cited || !ownMentionedChatIds.has(s.chat_id) || !store.project.domain) return false;
        try {
          const ownedHost = new URL(`https://${store.project.domain.replace(/^https?:\/\//, "")}`).hostname.toLowerCase().replace(/^www\./, "");
          const citedHost = new URL(s.url).hostname.toLowerCase().replace(/^www\./, "");
          return citedHost === ownedHost || citedHost.endsWith(`.${ownedHost}`);
        } catch {
          return false;
        }
      })
      .map((s) => s.chat_id),
  ).size;
  const citationSupport =
    mentionedAnswers === 0 ? 0 : citedMentionedChats / mentionedAnswers;
  const supportedPosition = positionQuality * adjustedPresence;
  const supportedCitations = citationSupport * adjustedPresence;
  const scoreValue =
    eligibleChats === 0
      ? null
      : Math.round(
          100 *
            (0.55 * adjustedPresence +
              0.25 * shareOfVoice +
              0.1 * supportedPosition +
              0.1 * supportedCitations),
        );
  const collectionReliability =
    scoreView.chats.length === 0 ? 0 : eligibleChats / scoreView.chats.length;
  const confidenceIndex =
    (0.6 * Math.min(1, eligibleChats / 30) +
      0.25 * Math.min(1, byChannel.size / 3) +
      0.15 * Math.min(1, scoreCountryCount / 3)) *
    collectionReliability;
  const confidence =
    eligibleChats === 0
      ? "insufficient"
      : confidenceIndex >= 0.75
        ? "strong"
        : confidenceIndex >= 0.45
          ? "directional"
          : "limited";

  const topicPromptCount = new Map<string, number>();
  const promptsByTopic = new Map<string, string[]>();
  for (const p of activePrompts) {
    if (!p.topic_id) continue;
    topicPromptCount.set(
      p.topic_id,
      (topicPromptCount.get(p.topic_id) ?? 0) + 1,
    );
    const list = promptsByTopic.get(p.topic_id) ?? [];
    list.push(p.id);
    promptsByTopic.set(p.topic_id, list);
  }
  const ownBrandId = own?.brand_id;
  const topicVisibilityIsProxy = false;
  const scopedTopicIds = store.analysisScope?.topicIds;
  const reportTopics = scopedTopicIds
    ? store.topics.filter((topic) => scopedTopicIds.includes(topic.id))
    : store.topics;
  const topics = reportTopics.slice(0, 8).map((t) => {
    const promptIds = new Set(promptsByTopic.get(t.id) ?? []);
    const topicChats = view.chats.filter(
      (c) =>
        promptIds.has(c.prompt_id) &&
        (c.status === "ok" || c.status === "empty"),
    );
    const eligible = topicChats.length;
    const topicChatIds = new Set(topicChats.map((c) => c.id));
    const mentionedChats = new Set<string>();
    if (ownBrandId && eligible > 0) {
      for (const m of view.mentions) {
        if (m.brand_id === ownBrandId && m.mention_count > 0 && topicChatIds.has(m.chat_id)) {
          mentionedChats.add(m.chat_id);
        }
      }
    }
    const mentioned = mentionedChats.size;
    const visibility =
      eligible > 0 ? mentioned / eligible : null;
    return {
      id: t.id,
      name: t.name,
      prompt_count: topicPromptCount.get(t.id) ?? 0,
      visibility,
      mention_estimate: mentioned,
      chats_eligible: eligible,
    };
  });

  const chatDay = new Map(
    view.chats.map((c) => [c.id, c.run_date.slice(0, 10)] as const),
  );
  const trendEligibleIds = new Set(view.chats.filter((c) => c.status === "ok" || c.status === "empty").map((c) => c.id));
  const trendMentionedIds = new Set<string>();
  const byDay = new Map<
    string,
    {
      chats: number;
      eligible: number;
      mentions: number;
      citations: number;
      citedUrls: Set<string>;
    }
  >();
  for (const c of view.chats) {
    const day = c.run_date.slice(0, 10);
    const cur = byDay.get(day) ?? {
      chats: 0,
      eligible: 0,
      mentions: 0,
      citations: 0,
      citedUrls: new Set<string>(),
    };
    cur.chats += 1;
    if (c.status === "ok" || c.status === "empty") cur.eligible += 1;
    byDay.set(day, cur);
  }
  if (own) {
    for (const m of view.mentions) {
      if (m.brand_id !== own.brand_id || m.mention_count <= 0 || !trendEligibleIds.has(m.chat_id) || trendMentionedIds.has(m.chat_id)) continue;
      trendMentionedIds.add(m.chat_id);
      const day = chatDay.get(m.chat_id);
      if (!day) continue;
      const cur = byDay.get(day);
      if (cur) cur.mentions += 1;
    }
  }
  for (const s of view.sources) {
    if (!s.cited) continue;
    const day = chatDay.get(s.chat_id);
    if (!day) continue;
    const cur = byDay.get(day);
    if (!cur) continue;
    cur.citations += 1;
    cur.citedUrls.add(s.url);
  }
  const series = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({
      date,
      chats: v.chats,
      eligible_answers: v.eligible,
      mentions: v.mentions,
      citations: v.citations,
      cited_pages: v.citedUrls.size,
      visibility: v.eligible === 0 ? null : v.mentions / v.eligible,
    }));

  // A matching prompt id alone is insufficient: route, model and market must
  // also agree before observations are compared across dates.
  const cellsByDay = new Map<string, string[]>();
  for (const chat of view.chats) {
    const day = chat.run_date.slice(0, 10);
    const cells = cellsByDay.get(day) ?? [];
    if (trendEligibleIds.has(chat.id)) cells.push(JSON.stringify([chat.prompt_id, chat.model_channel_id, chat.model_reported ?? "unknown", chat.country_code, chat.surface_kind ?? "unknown", chat.retrieval_mode ?? "unknown"]));
    cellsByDay.set(day, cells);
  }
  const daySignatures = [...cellsByDay.values()].map((cells) => JSON.stringify(cells.sort()));
  const trendComparable = daySignatures.length >= 2 && daySignatures.every((signature) => signature !== "[]") && new Set(daySignatures).size === 1;
  const cohortId = createHash("sha256").update(JSON.stringify({
    prompts: scorePrompts.map((prompt) => [prompt.id, prompt.text, prompt.country_code]).sort(),
    brands: scopedBrands.map((brand) => [brand.id, brand.name, brand.aliases, brand.patterns]).sort(),
    channel: parsed.channel,
  })).digest("hex");

  const domainMap = new Map<string, number>();
  for (const s of view.sources) {
    if (!s.cited) continue;
    domainMap.set(s.domain, (domainMap.get(s.domain) ?? 0) + 1);
  }
  const cited_domains = [...domainMap.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const opportunity_state =
    eligibleChats > 0 && mentionedAnswers === 0
      ? {
          state: "not_mentioned" as const,
          headline: `${own?.brand_name ?? "The analyzed brand"} was not mentioned in ${eligibleChats} eligible answer${eligibleChats === 1 ? "" : "s"}.`,
          interpretation:
            "This is a measured zero for the active non-branded prompt cohort, not a collection failure or an estimate of total market awareness.",
          competitor_winners: ranked
            .filter((row) => !row.is_own && row.mention_count > 0)
            .slice(0, 3)
            .map((row) => ({
              brand_id: row.brand_id,
              brand_name: row.brand_name,
              mentioned_answers: row.visibility_count,
              presence: row.visibility,
            })),
          cited_domains: cited_domains.slice(0, 3),
          markets_without_mentions: countries
            .filter(
              (country) =>
                country.eligible_answers > 0 && country.mentioned_answers === 0,
            )
            .map((country) => ({
              code: country.code,
              eligible_answers: country.eligible_answers,
            })),
        }
      : null;

  const liveSurfaces = view.chats.filter(
    (c) => c.surface_kind === "api" || c.surface_kind === "ui",
  ).length;
  const fixtureLike = view.chats.filter((c) =>
    (c.text ?? "").includes("fixture surface"),
  ).length;
  const channelIds = new Set(view.chats.map((c) => c.model_channel_id));
  const collectionMode =
    view.chats.length === 0
      ? "empty"
      : fixtureLike === 0
        ? "live"
        : fixtureLike === view.chats.length
          ? "fixture"
          : "mixed";
  const rangeLabel =
    parsed.range === "90d"
      ? "Last 90 days"
      : parsed.range === "30d"
        ? "Last 30 days"
        : "Last 7 days";
  const channelNote = parsed.channel ? `, ${parsed.channel} only` : "";
  const windowNote = `${rangeLabel} (${from} to ${to})${channelNote}.`;
  const eligibleAttemptCount = view.chats.filter(
    (chat) => chat.status === "ok" || chat.status === "empty",
  ).length;
  const failedAttemptCount = view.chats.filter(
    (chat) => chat.status === "error" || chat.status === "blocked",
  ).length;
  const sampleNote = `Figures are from ${view.chats.length} collection attempt${
    view.chats.length === 1 ? "" : "s"
  } (${eligibleAttemptCount} eligible answer${
    eligibleAttemptCount === 1 ? "" : "s"
  }, ${failedAttemptCount} failed or blocked) across ${channelIds.size} observed route${
    channelIds.size === 1 ? "" : "s"
  } in this project — not a multi-month industry index.`;
  const fixtureNote =
    collectionMode === "fixture" || collectionMode === "mixed"
      ? " Adapter fixtures are synthetic answers for local/dev collection. They will not match live LLM or Semrush-scale totals. Add provider keys (or Cursor/OpenRouter) and Analyze again for real answers."
      : " Country is the requested market on chats, not true localization.";

  return {
    project_id: store.project.id,
    domain: store.project.domain ?? null,
    brand: own
      ? {
          id: own.brand_id,
          name: own.brand_name,
          visibility: own.visibility,
          share_of_voice: own.share_of_voice,
          position: own.position,
          sentiment: own.sentiment,
          mention_count: own.mention_count,
          rank: ownRank,
          of: ranked.length,
        }
      : null,
    evidence: {
      mentioned_answers: own?.visibility_count ?? 0,
      eligible_answers: eligibleChats,
      observed_presence: own?.visibility ?? 0,
      failed_attempts: view.chats.filter(
        (c) => c.status === "error" || c.status === "blocked",
      ).length,
      label: "Observed presence",
      note: "The raw presence rate remains visible beside the composite score.",
    },
    collection_health: [
      ...new Set(
        view.chats
          .map((c) => c.model_channel_id)
          .filter(
            (channelId) =>
              !store.commercial?.enabled_channel_ids?.length ||
              store.commercial.enabled_channel_ids.includes(channelId),
          ),
      ),
    ].map((channelId) => {
      const attempts = view.chats.filter((c) => c.model_channel_id === channelId);
      // A day can contain retries. Report the newest immutable observation for
      // each prompt so a successful recovery is not permanently shown as down.
      const latestByPrompt = new Map<string, (typeof attempts)[number]>();
      for (const attempt of attempts) {
        const previous = latestByPrompt.get(attempt.prompt_id);
        const attemptOrder = `${attempt.collected_at ?? attempt.run_date}|${attempt.run_date}|${attempt.id}`;
        const previousOrder = previous
          ? `${previous.collected_at ?? previous.run_date}|${previous.run_date}|${previous.id}`
          : "";
        if (!previous || attemptOrder > previousOrder) {
          latestByPrompt.set(attempt.prompt_id, attempt);
        }
      }
      const latest = [...latestByPrompt.values()];
      const latestDate = latest.map((c) => c.run_date).sort().at(-1)!;
      const successful = latest.filter((c) => c.status === "ok" || c.status === "empty").length;
      const failures = latest.filter((c) => c.status === "error" || c.status === "blocked");
      const details = failures.map((c) => `${c.error_code ?? ""} ${c.error_detail ?? ""} ${JSON.stringify(c.raw_payload ?? {})}`).join(" ");
      const action = /429|quota|RESOURCE_EXHAUSTED|credit|balance/i.test(details)
        ? "Restore provider quota or credits, then retry collection."
        : /401|403|api.key|unauthorized|authentication/i.test(details)
          ? "Check the provider credential and account permissions, then retry collection."
          : "Review the failed attempts in Chats and retry after resolving the provider error.";
      return { channel_id: channelId, latest_date: latestDate, attempts: latest.length,
        eligible_answers: successful, failures: failures.length,
        status: failures.length === 0 ? "healthy" : successful === 0 ? "unavailable" : "partial",
        action: failures.length ? action : "Collection succeeded for the latest observation of every active prompt." };
    }),
    score: {
      value: scoreValue,
      label: "Experimental GeoLens score",
      confidence: eligibleChats === 0 ? "insufficient" : "unvalidated",
      sample_coverage: confidence,
      sample_coverage_index: Number(confidenceIndex.toFixed(3)),
      range: null as { low: number; high: number } | null,
      components: {
        presence: Math.round(adjustedPresence * 100),
        share_of_voice: Math.round(shareOfVoice * 100),
        position: Math.round(supportedPosition * 100),
        citation_support: Math.round(supportedCitations * 100),
      },
      weights: {
        presence: 55,
        share_of_voice: 25,
        position: 10,
        citation_support: 10,
      },
      methodology:
        "Experimental, uncalibrated weights: 55% observed presence + 25% configured-brand mention share + 10% presence-weighted mention position + 10% owned-domain citation coverage. Owned-domain citations do not establish endorsement. This describes the selected prompt sample, not market-wide visibility. No statistical confidence interval for this composite has been validated.",
    },
    prompt_cohort: {
      id: cohortId,
      active_prompts: activePrompts.length,
      score_prompts: scorePrompts.length,
      branded_prompts_excluded: activePrompts.length - scorePrompts.length,
      archived_prompts_excluded: store.prompts.filter(
        (prompt) => prompt.status === "archived",
      ).length,
      collected_answers: view.chats.length,
      score_answers: scoreView.chats.length,
    },
    kpis: {
      mentions: own?.mention_count ?? 0,
      citations: view.sources.filter((s) => s.cited).length,
      cited_pages: new Set(
        view.sources.filter((s) => s.cited).map((s) => s.url),
      ).size,
      chats: view.chats.length,
    },
    filters: {
      range: parsed.range,
      channel: parsed.channel ?? "all",
      from,
      to,
    },
    channels,
    countries,
    competitors: ranked.slice(0, 6).map((r) => ({
      brand_id: r.brand_id,
      brand_name: r.brand_name,
      is_own: Boolean(r.is_own),
      visibility: r.visibility,
      share_of_voice: r.share_of_voice,
      mention_count: r.mention_count,
    })),
    topics,
    series,
    cited_domains,
    opportunity_state,
    honesty: {
      trend_comparable: trendComparable,
      trend_note: "Trend comparability requires the same eligible prompt versions, routes, reported models and markets on every observed day. Counts are descriptive; repeated observations are not independent market samples.",
      series_is_collected: series.length >= 1 && view.chats.length > 0,
      country_is_requested_market: true,
      topic_visibility_is_proxy: topicVisibilityIsProxy,
      score_sample_thin:
        eligibleChats < 30 || byChannel.size < 3 || scoreCountryCount < 3,
      collection_is_live: liveSurfaces > 0 && fixtureLike === 0,
      collection_mode: collectionMode,
      fixture_chats: fixtureLike,
      channel_count: channelIds.size,
      chats_collected: view.chats.length,
      range: parsed.range,
      channel: parsed.channel ?? "all",
      from,
      to,
      note: `${windowNote} ${sampleNote}${fixtureNote}`,
    },
  };
}

