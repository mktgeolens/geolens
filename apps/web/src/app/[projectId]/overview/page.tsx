import { apiFetch } from "@/lib/api-server";
import Link from "next/link";
import { RankBars, TrendChart } from "@/components/charts";
import { ApiDownCallout } from "@/components/api-down-callout";
import { ExportOverviewButton } from "./export-button";
import { ShareOverviewButton } from "./share-button";

type Overview = {
  collection_health?: { channel_id: string; latest_date: string; attempts: number; eligible_answers: number; failures: number; status: string; action: string }[];
  brand: {
    id: string;
    name: string;
    visibility: number;
    share_of_voice: number;
    position: number | null;
    sentiment: number | null;
    mention_count: number;
    rank: number | null;
    of: number;
  } | null;
  evidence: {
    mentioned_answers: number;
    eligible_answers: number;
    observed_presence: number;
    failed_attempts: number;
    label: string;
    note: string;
  };
  score: {
    value: number | null;
    label: string;
    confidence: "insufficient" | "limited" | "directional" | "strong" | "unvalidated";
    sample_coverage_index: number;
    range: { low: number; high: number } | null;
    components: {
      presence: number;
      share_of_voice: number;
      position: number;
      citation_support: number;
    };
    weights: {
      presence: number;
      share_of_voice: number;
      position: number;
      citation_support: number;
    };
    methodology: string;
  };
  prompt_cohort: {
    active_prompts: number;
    score_prompts: number;
    branded_prompts_excluded: number;
    archived_prompts_excluded: number;
    collected_answers: number;
    score_answers: number;
  };
  kpis: {
    mentions: number;
    citations: number;
    cited_pages: number;
    chats: number;
  };
  channels: {
    channel_id: string;
    label: string;
    models_reported: string[];
    chat_count: number;
    mention_count: number;
    visibility: number;
    share: number;
  }[];
  countries: {
    code: string;
    count: number;
    attempt_count: number;
    eligible_answers: number;
    mentioned_answers: number;
    presence: number;
  }[];
  competitors: {
    brand_id: string;
    brand_name: string;
    is_own: boolean;
    visibility: number;
    share_of_voice?: number;
    mention_count: number;
  }[];
  topics: {
    id: string;
    name: string;
    prompt_count: number;
    visibility: number | null;
    mention_estimate: number;
    chats_eligible?: number;
  }[];
  series: {
    date: string;
    chats: number;
    mentions: number;
    citations?: number;
    cited_pages?: number;
    visibility: number;
  }[];
  cited_domains: { domain: string; count: number }[];
  opportunity_state: {
    state: "not_mentioned";
    headline: string;
    interpretation: string;
    competitor_winners: {
      brand_id: string;
      brand_name: string;
      mentioned_answers: number;
      presence: number;
    }[];
    cited_domains: { domain: string; count: number }[];
    markets_without_mentions: { code: string; eligible_answers: number }[];
  } | null;
  domain?: string | null;
  filters?: {
    range: string;
    channel: string;
    from: string;
    to: string;
  };
  honesty: {
    series_is_collected: boolean;
    trend_comparable?: boolean;
    trend_note?: string;
    country_is_requested_market: boolean;
    topic_visibility_is_proxy: boolean;
    score_sample_thin?: boolean;
    collection_is_live?: boolean;
    collection_mode?: "empty" | "live" | "fixture" | "mixed";
    fixture_chats?: number;
    channel_count?: number;
    chats_collected?: number;
    from?: string;
    to?: string;
    note: string;
  };
};

type ActionRow = { id: string; overview: string; status: string };

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await apiFetch(path);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function pct(n: number, digits = 0) {
  return `${(n * 100).toFixed(digits)}%`;
}

function fmt(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function channelLabel(channel: Overview["channels"][number]) {
  const models = (channel.models_reported ?? []).filter(Boolean);
  if (models.length > 0) {
    return `${models.join(", ")} · ${channel.channel_id} route`;
  }
  return `Model unreported · ${channel.channel_id} route`;
}

function parseRange(raw: string | undefined): "7d" | "30d" | "90d" {
  if (raw === "30d" || raw === "90d") return raw;
  return "7d";
}

function seriesDelta(
  series: Overview["series"],
  key: "mentions" | "visibility" | "citations" | "cited_pages",
): number | null {
  if (series.length < 2) return null;
  const first = series[0]![key] ?? 0;
  const last = series[series.length - 1]![key] ?? 0;
  if (key === "visibility") {
    return Math.round((last - first) * 100);
  }
  if (first <= 0) return null;
  return Math.round(((last - first) / first) * 100);
}

function channelColor(id: string) {
  if (id.startsWith("openai") || id.includes("chatgpt")) return "var(--positive)";
  if (id.startsWith("perplexity")) return "var(--chart-1)";
  if (id.includes("overview") || id.includes("ai-overview"))
    return "var(--chart-4)";
  if (id.includes("ai-mode")) return "var(--chart-5)";
  if (id.startsWith("google") || id.includes("gemini")) return "var(--chart-2)";
  if (id.startsWith("anthropic") || id.includes("claude")) return "var(--chart-3)";
  if (id.includes("copilot")) return "var(--signal)";
  if (id.startsWith("sim")) return "var(--muted)";
  return "var(--accent)";
}

function DeltaChip({
  value,
  suffix = "%",
}: {
  value: number | null;
  suffix?: string;
}) {
  if (value == null) return null;
  const cls =
    value > 0
      ? "geo-badge geo-badge-positive"
      : value < 0
        ? "geo-badge geo-badge-warm"
        : "geo-badge geo-badge-neutral";
  const sign = value > 0 ? "+" : "";
  return (
    <span className={cls}>
      {sign}
      {value}
      {suffix}
    </span>
  );
}

function EmptyBlock({ title, body }: { title: string; body: string }) {
  return (
    <div className="geo-empty geo-empty-compact">
      <p className="geo-empty-title">{title}</p>
      <p className="geo-empty-body">{body}</p>
    </div>
  );
}

const COUNTRY_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--muted-2)",
];

export default async function OverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ range?: string; channel?: string }>;
}) {
  const { projectId } = await params;
  const query = await searchParams;
  const range = parseRange(query.range);
  const channel =
    query.channel && query.channel !== "all" ? query.channel : "";
  const qs = new URLSearchParams({ range });
  if (channel) qs.set("channel", channel);

  const [overview, actions, projectPayload] = await Promise.all([
    fetchJson<Overview>(
      `/v1/projects/${projectId}/reports/overview?${qs.toString()}`,
    ),
    fetchJson<{ rows: ActionRow[] }>(
      `/v1/projects/${projectId}/actions?status=new`,
    ),
    fetchJson<{ project?: { domain?: string } }>(
      `/v1/projects/${projectId}`,
    ),
  ]);
  const projectDomain =
    overview?.domain ?? projectPayload?.project?.domain ?? "";

  const brand = overview?.brand;
  const rawSeries = overview?.series ?? [];
  const chartSeries =
    rawSeries.length >= 1
      ? [
          {
            label: "Mentions",
            color: "var(--chart-1)",
            points: rawSeries.map((s) => s.mentions),
            total: overview?.kpis.mentions,
          },
          {
            label: "Citations",
            color: "var(--chart-2)",
            points: rawSeries.map((s) => s.citations ?? 0),
            total: overview?.kpis.citations,
          },
          {
            label: "Cited pages",
            color: "var(--chart-4)",
            points: rawSeries.map((s) => s.cited_pages ?? 0),
            dashed: true,
            total: overview?.kpis.cited_pages,
          },
        ]
      : [];
  const chartLabels = rawSeries.map((s) => s.date);

  const fixtureSample =
    overview?.honesty.collection_mode === "fixture" ||
    overview?.honesty.collection_mode === "mixed" ||
    (overview?.honesty.fixture_chats ?? 0) > 0;
  const showCollectionCallout = Boolean(
    overview &&
      (overview.honesty.score_sample_thin ||
        (fixtureSample && overview.kpis.chats < 16)),
  );
  const indexBadge = !overview
    ? null
    : overview.honesty.collection_is_live
      ? { label: "Live collection", className: "geo-badge geo-badge-positive" }
      : fixtureSample
        ? { label: "Fixture sample", className: "geo-badge geo-badge-warm" }
        : overview.kpis.chats > 0
          ? { label: "Collected sample", className: "geo-badge geo-badge-neutral" }
          : { label: "Awaiting collect", className: "geo-badge geo-badge-warm" };

  const mentionDelta = overview
    ? seriesDelta(overview.series, "mentions")
    : null;
  const citationDelta = overview
    ? seriesDelta(overview.series, "citations")
    : null;
  const citedDelta = overview
    ? seriesDelta(overview.series, "cited_pages")
    : null;
  const countryRows = (overview?.countries ?? []).slice(0, 6);

  const windowFrom = overview?.filters?.from ?? overview?.honesty.from;
  const windowTo = overview?.filters?.to ?? overview?.honesty.to;
  const ledeRank =
    brand?.rank != null && (overview?.evidence.eligible_answers ?? 0) > 0
      ? ` Rank ${brand.rank}/${brand.of} among tracked brands.`
      : "";
  const scoreValue = overview?.score.value ?? null;
  const scoreBand =
    scoreValue == null ? "low" : scoreValue >= 70 ? "high" : scoreValue >= 40 ? "medium" : "low";

  return (
    <div className="geo-vis">
      <header className="geo-vis-header">
        <div>
          <div className="geo-vis-title-row">
            <h1>Visibility overview</h1>
            {indexBadge ? (
              <span className={indexBadge.className}>{indexBadge.label}</span>
            ) : null}
          </div>
          <p className="geo-page-lede">
            How often collected API responses mention {brand ? brand.name : "your brand"}
            {projectDomain ? ` (${projectDomain})` : ""}.{ledeRank}
          </p>
          {overview ? (
            <p className="geo-vis-context">
              <span>{overview.evidence.eligible_answers} eligible answers</span>
              <span>{overview.honesty.channel_count ?? overview.channels.length} API channels</span>
              {windowFrom && windowTo ? <span>{windowFrom}–{windowTo}</span> : null}
            </p>
          ) : null}
        </div>
        <div className="geo-vis-actions">
          <ExportOverviewButton projectId={projectId} />
          <ShareOverviewButton projectId={projectId} />
          <Link href={`/${projectId}/settings/reports`} className="geo-btn geo-btn-sm">Email reports</Link>
          <Link
            href={`/${projectId}/prompts`}
            className="geo-btn geo-btn-primary geo-btn-sm"
          >
            Run analysis
          </Link>
        </div>
      </header>

      {!overview && <ApiDownCallout noun="overview" />}

      {overview && showCollectionCallout ? (
        <div
          role="status"
          className="geo-callout geo-callout-warning"
          style={{ marginBottom: "var(--space-4)" }}
        >
          <span>{overview.honesty.note}</span>
        </div>
      ) : null}

      {overview && (
        <>
          {overview.collection_health?.some((channel) => channel.failures > 0) && (
            <section className="geo-collection-health" aria-label="Collection needs attention">
              <div className="geo-collection-health-head">
                <div>
                  <span className="geo-badge geo-badge-warm">Partial collection</span>
                  <h2>Collection needs attention</h2>
                </div>
                <Link href={`/${projectId}/chats`} className="geo-btn geo-btn-ghost geo-btn-sm">Review attempts</Link>
              </div>
              <ul>
                {overview.collection_health.filter((channel) => channel.failures > 0).map((channel) => (
                  <li key={channel.channel_id}>
                    <div>
                      <strong>{channel.channel_id}</strong>
                      <span>{channel.eligible_answers}/{channel.attempts} answers · {channel.latest_date}</span>
                    </div>
                    <p>{channel.action}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {overview.opportunity_state?.state === "not_mentioned" ? (
            <section
              className="geo-panel geo-vis-panel"
              style={{ marginBottom: "var(--space-4)" }}
              aria-label="Brand visibility opportunity"
            >
              <div className="geo-vis-panel-head">
                <div>
                  <span className="geo-badge geo-badge-warm">Measured visibility gap</span>
                  <h2 className="geo-section-title" style={{ marginTop: "var(--space-2)" }}>
                    {overview.opportunity_state.headline}
                  </h2>
                </div>
                <Link href={`/${projectId}/prompts`} className="geo-btn geo-btn-ghost geo-btn-sm">
                  Inspect prompt evidence
                </Link>
              </div>
              <p className="geo-muted">{overview.opportunity_state.interpretation}</p>
              {overview.opportunity_state.competitor_winners.length > 0 ? (
                <p className="geo-vis-note">
                  Brands appearing instead: {overview.opportunity_state.competitor_winners
                    .map((row) => `${row.brand_name} (${row.mentioned_answers} answers)`)
                    .join(" · ")}.
                </p>
              ) : null}
              {overview.opportunity_state.cited_domains.length > 0 ? (
                <p className="geo-vis-note">
                  Most cited source domains in this cohort: {overview.opportunity_state.cited_domains
                    .map((row) => `${row.domain} (${row.count})`)
                    .join(" · ")}.
                </p>
              ) : null}
              <div className="geo-vis-actions" style={{ marginTop: "var(--space-3)" }}>
                <Link href={`/${projectId}/competitors`} className="geo-btn geo-btn-ghost geo-btn-sm">
                  Compare winning brands
                </Link>
                <Link href={`/${projectId}/sources/domains`} className="geo-btn geo-btn-ghost geo-btn-sm">
                  Review cited sources
                </Link>
                <Link href={`/${projectId}/actions`} className="geo-btn geo-btn-primary geo-btn-sm">
                  Build an action plan
                </Link>
              </div>
            </section>
          ) : null}
          <p className="geo-vis-method-note">
            Overview measures {overview.prompt_cohort.score_prompts} active discovery prompts in the selected period.
            Branded and archived prompts are excluded. A zero means no brand mentions in eligible answers for this sample.
            {" "}<Link href={`/${projectId}/prompts`}>Review your prompt panel</Link>
            {" · "}<Link href={`/${projectId}/brands`}>View historical brand results</Link>
          </p>
          <section className="geo-overview-hero" aria-label="Visibility score and collected trend">
          <div className="geo-vis-kpis">
            <article className="geo-vis-kpi">
              <div className="geo-vis-kpi-head">
                <p className="geo-vis-kpi-label">Mentions</p>
                <DeltaChip value={mentionDelta} />
              </div>
              <p className="geo-vis-kpi-value">{fmt(overview.kpis.mentions)}</p>
              <p className="geo-vis-kpi-meta">
                Across {overview.kpis.chats} chats
              </p>
            </article>
            <article className="geo-vis-kpi">
              <div className="geo-vis-kpi-head">
                <p className="geo-vis-kpi-label">Citations</p>
                <DeltaChip value={citationDelta} />
              </div>
              <p className="geo-vis-kpi-value">
                {fmt(overview.kpis.citations)}
              </p>
              <p className="geo-vis-kpi-meta">Cited source rows</p>
            </article>
            <article className="geo-vis-kpi">
              <div className="geo-vis-kpi-head">
                <p className="geo-vis-kpi-label">Cited pages</p>
                <DeltaChip value={citedDelta} />
              </div>
              <p className="geo-vis-kpi-value">
                {fmt(overview.kpis.cited_pages)}
              </p>
              <p className="geo-vis-kpi-meta">Unique URLs</p>
            </article>
            <article className="geo-vis-kpi">
              <p className="geo-vis-kpi-label">Collection failures</p>
              <p className="geo-vis-kpi-value">
                {overview.evidence.failed_attempts}
              </p>
              <p className="geo-vis-kpi-meta">Error or blocked attempts</p>
            </article>
          </div>

          <div className="geo-vis-grid-main">
            <section className="geo-vis-panel geo-vis-score-card">
              <div className="geo-vis-panel-head">
                <h2 className="geo-section-title" style={{ margin: 0 }}>
                  Visibility score
                </h2>
                <span
                  className={`geo-badge ${
                    overview.score.confidence === "strong"
                      ? "geo-badge-positive"
                      : overview.score.confidence === "directional"
                        ? "geo-badge-neutral"
                        : "geo-badge-warm"
                  }`}
                >
                  Uncalibrated · sample only
                </span>
              </div>
              <div className="geo-gauge" data-band={scoreBand}>
                <svg
                  className="geo-gauge-svg"
                  viewBox="0 0 240 126"
                  role="img"
                  aria-label={
                    scoreValue == null
                      ? "Visibility score unavailable"
                      : `GeoLens Visibility Score ${scoreValue} out of 100`
                  }
                >
                  <path
                    className="geo-gauge-track"
                    d="M24 108 A96 96 0 0 1 216 108"
                    pathLength="100"
                    fill="none"
                    strokeWidth="18"
                    strokeLinecap="round"
                  />
                  {scoreValue != null && scoreValue > 0 ? (
                    <path
                      className="geo-gauge-fill"
                      d="M24 108 A96 96 0 0 1 216 108"
                      pathLength="100"
                      fill="none"
                      strokeWidth="18"
                      strokeLinecap="round"
                      strokeDasharray={`${scoreValue} 100`}
                    />
                  ) : null}
                </svg>
                <div className="geo-gauge-readout">
                  <strong>
                    {scoreValue ?? "–"}<span>/100</span>
                  </strong>
                  <em>{scoreBand}</em>
                </div>
              </div>
              <p className="geo-vis-insight">
                {overview.score.range
                  ? `Estimated range ${overview.score.range.low}–${overview.score.range.high}. `
                  : overview.evidence.eligible_answers > 0 ? "No validated score interval. " : "Awaiting collection for the active discovery prompts. "}
                {overview.evidence.eligible_answers > 0
                  ? `Raw presence: ${overview.evidence.mentioned_answers}/${overview.evidence.eligible_answers} eligible answers (${pct(overview.evidence.observed_presence)}).`
                  : "No previous prompt version is reused."}
              </p>
              <fieldset className="geo-score-breakdown">
                <legend className="sr-only">Score component breakdown</legend>
                <span><strong>{overview.score.components.presence}</strong> Presence · 55%</span>
                <span><strong>{overview.score.components.share_of_voice}</strong> Share of voice · 25%</span>
                <span><strong>{overview.score.components.position}</strong> Position support · 10%</span>
                <span><strong>{overview.score.components.citation_support}</strong> Owned-domain citations · 10%</span>
              </fieldset>
              <details className="geo-score-method">
                <summary>How this score works</summary>
                <p>{overview.score.methodology}</p>
                <p>
                  Cohort: {overview.prompt_cohort.score_prompts} active discovery prompts,
                  {" "}{overview.prompt_cohort.score_answers} collected attempts.
                  {overview.prompt_cohort.branded_prompts_excluded > 0
                    ? ` ${overview.prompt_cohort.branded_prompts_excluded} branded prompts excluded.`
                    : ""}
                  {overview.prompt_cohort.archived_prompts_excluded > 0
                    ? ` ${overview.prompt_cohort.archived_prompts_excluded} archived prompts excluded.`
                    : ""}
                </p>
              </details>
            </section>

            <section className="geo-vis-panel geo-vis-trend-card">
              <div className="geo-vis-panel-head">
                <h2 className="geo-section-title" style={{ margin: 0 }}>
                  Evidence over time
                </h2>
                <span
                  className={`geo-badge ${
                    overview.honesty.trend_comparable
                      ? "geo-badge-positive"
                      : "geo-badge-neutral"
                  }`}
                >
                  {overview.honesty.trend_comparable
                    ? "Matched coverage"
                    : overview.series.length < 2 ? "Sparse history" : "Coverage differs"}
                </span>
              </div>
              {chartSeries.length > 0 ? (
                <>
                  <TrendChart
                    series={chartSeries}
                    labels={chartLabels}
                    legendValue="sum"
                    ariaLabel="Mentions, citations, and cited pages over the selected range"
                  />
                  <p className="geo-vis-note">
                    {overview.series.length} day
                    {overview.series.length === 1 ? "" : "s"}
                    {windowFrom && windowTo
                      ? ` (${windowFrom} to ${windowTo})`
                      : ""}{" "}
                    from collected chats for {projectDomain || "this project"}.
                    {" "}{overview.honesty.trend_note}
                  </p>
                </>
              ) : (
                <EmptyBlock
                  title="No collected trend yet"
                  body="Enter a domain in the top bar and click Analyze to collect real AI answers for this brand."
                />
              )}
            </section>
          </div>
          </section>

          <div className="geo-vis-grid-bottom">
            <section className="geo-panel geo-vis-panel">
              <div className="geo-vis-panel-head">
                <h2 className="geo-section-title" style={{ margin: 0 }}>
                  Distribution by LLM
                </h2>
                <span className="geo-badge geo-badge-neutral">Mentions</span>
              </div>
              {overview.channels.length > 0 ? (
                <ul className="geo-vis-bars">
                  {overview.channels.slice(0, 6).map((ch) => (
                    <li key={ch.channel_id}>
                      <div className="geo-vis-bar-meta">
                        <span className="geo-vis-bar-label">
                          <i
                            style={{ background: channelColor(ch.channel_id) }}
                            aria-hidden
                          />
                          {channelLabel(ch)}
                        </span>
                        <span className="mono">
                          {pct(ch.share, 1)} · {fmt(ch.mention_count)}
                        </span>
                      </div>
                      <div className="geo-vis-bar-track">
                        <span
                          style={{
                            width: `${Math.max(2, ch.share * 100)}%`,
                            background: channelColor(ch.channel_id),
                          }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyBlock
                  title="No LLM mentions yet"
                  body="Run Analyze from the top bar to collect answers across models."
                />
              )}
            </section>

            <section className="geo-panel geo-vis-panel">
              <div className="geo-vis-panel-head">
                <h2 className="geo-section-title" style={{ margin: 0 }}>
                  Presence by requested market
                </h2>
                <span className="geo-badge geo-badge-neutral">
                  Eligible answers
                </span>
              </div>
              {countryRows.length > 0 ? (
                <>
                  <ul className="geo-vis-country-list">
                    {countryRows.map((c, i) => (
                      <li key={c.code}>
                        <i
                          style={{
                            background:
                              COUNTRY_COLORS[i % COUNTRY_COLORS.length],
                          }}
                        />
                        <span>{c.code}</span>
                        <strong>
                          {c.eligible_answers > 0
                            ? `${pct(c.presence, 1)} · ${c.mentioned_answers}/${c.eligible_answers}`
                            : `No eligible answer · ${c.attempt_count} attempts`}
                        </strong>
                      </li>
                    ))}
                  </ul>
                  <p className="geo-vis-note">
                    Presence is the share of eligible collected answers in each requested market
                    that mention {brand?.name ?? "the analyzed brand"}. This is prompt-market
                    coverage, not user location. {overview.honesty.note}
                  </p>
                </>
              ) : (
                <EmptyBlock
                  title="No market presence yet"
                  body="Analyze a domain in the top bar to collect chats with a requested market."
                />
              )}
            </section>
          </div>

          <div className="geo-vis-grid-bottom">
            <section className="geo-panel geo-vis-panel">
              <div className="geo-vis-panel-head">
                <h2 className="geo-section-title" style={{ margin: 0 }}>
                  {overview.opportunity_state?.state === "not_mentioned"
                    ? "Who appears instead"
                    : "Observed tracked-brand mentions"}
                </h2>
                <span className="geo-badge geo-badge-neutral">
                  Presence in eligible answers
                </span>
              </div>
              {overview.competitors.length > 0 ? (
                <RankBars
                  rows={overview.competitors.map((r) => ({
                    name: r.brand_name,
                    pct: r.visibility * 100,
                    highlight: r.is_own,
                  }))}
                />
              ) : (
                <EmptyBlock
                  title="No tracked-brand comparison yet"
                  body="Add tracked brands, then run analysis to compare observed mentions in this sample."
                />
              )}
            </section>

            <section className="geo-panel geo-vis-panel">
              <div className="geo-vis-panel-head">
                <h2 className="geo-section-title" style={{ margin: 0 }}>
                  Topics &amp; sources
                </h2>
                <Link
                  href={`/${projectId}/topics`}
                  className="geo-link-quiet"
                >
                  Manage
                </Link>
              </div>
              {overview.topics.length > 0 ? (
                <div className="geo-comp-table-wrap">
                  <table className="geo-comp-table">
                    <thead>
                      <tr>
                        <th>Topic</th>
                        <th>Prompts</th>
                        <th>Visibility</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {overview.topics.slice(0, 5).map((t) => (
                        <tr key={t.id}>
                          <td>
                            <strong>{t.name}</strong>
                            {overview.honesty.topic_visibility_is_proxy && (
                              <small className="geo-pr-row-meta">
                                Proxy score
                              </small>
                            )}
                          </td>
                          <td>{t.prompt_count}</td>
                          <td>
                            {t.chats_eligible != null && t.chats_eligible < 8
                              ? t.chats_eligible === 0
                                ? "—"
                                : `${t.mention_estimate}/${t.chats_eligible}`
                              : t.visibility == null ? "—" : pct(t.visibility)}
                          </td>
                          <td>
                            <Link
                              href={`/${projectId}/prompts`}
                              className="geo-btn geo-btn-ghost geo-btn-sm"
                            >
                              Monitor
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyBlock
                  title="No topics yet"
                  body="Add topics in Topics and tags, then Analyze to score them."
                />
              )}
              {overview.cited_domains.length > 0 ? (
                <p className="geo-vis-note">
                  Top cited:{" "}
                  {overview.cited_domains
                    .slice(0, 3)
                    .map((d) => d.domain)
                    .join(" · ")}
                </p>
              ) : null}
            </section>
          </div>

          <div className="geo-vis-grid-bottom">
            <section className="geo-panel geo-vis-panel">
              <h2 className="geo-section-title">
                Top actions
                <Link href={`/${projectId}/actions`} className="geo-link-quiet">
                  View all
                </Link>
              </h2>
              {(actions?.rows?.length ?? 0) > 0 ? (
                <ul className="geo-list-plain">
                  {(actions?.rows ?? []).slice(0, 4).map((a) => (
                    <li key={a.id}>
                      <Link href={`/${projectId}/actions/${a.id}`}>
                        <span style={{ fontWeight: 500 }}>{a.overview}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyBlock
                  title="No open actions"
                  body="Generate actions from the Actions page after you have collected chats."
                />
              )}
            </section>

            <section className="geo-panel geo-vis-panel">
              <h2 className="geo-section-title">
                Next steps
                <Link
                  href={`/${projectId}/competitors`}
                  className="geo-link-quiet"
                >
                  Competitors
                </Link>
              </h2>
              <div
                className="geo-vis-actions"
                style={{ flexDirection: "column", alignItems: "stretch" }}
              >
                <Link
                  href={`/${projectId}/discovery`}
                  className="geo-btn geo-btn-ghost geo-btn-sm"
                >
                  Prompt Research
                </Link>
                <Link
                  href={`/${projectId}/sources/domains`}
                  className="geo-btn geo-btn-ghost geo-btn-sm"
                >
                  Sources &amp; Citations
                </Link>
                <Link
                  href={`/${projectId}/perception`}
                  className="geo-btn geo-btn-ghost geo-btn-sm"
                >
                  Perception &amp; Sentiment
                </Link>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
