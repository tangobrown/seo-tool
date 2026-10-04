import type { SiteMetrics } from "@/db/schema";
import type { Signals } from "@/domain/opportunities/types";
import type { Cannibalization, Declining, LowHangingFruit, SiteguruSiteRaw, TodoList, TopKeywords, TrafficOverview } from "./schemas";

export function siteDomain(raw: string): string {
  return raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, "").toLowerCase();
}

/** Exact domain match, ignoring scheme and www. Never guesses between near matches. */
export function matchSite(sites: SiteguruSiteRaw[], clientDomain: string): SiteguruSiteRaw | null {
  const want = siteDomain(clientDomain);
  return sites.find((s) => siteDomain(s.domain) === want) ?? null;
}

/**
 * Maps SiteGuru's overview + keywords to our snapshot. Anything SiteGuru doesn't provide stays null
 * (shown as "—"): it has no site-wide average position, and no Search Console figures when GSC isn't connected.
 */
export function toRollingMetrics(overview: TrafficOverview, keywords: TopKeywords | null): SiteMetrics {
  const gsc = overview.search_console?.status === "ok" ? overview.search_console : undefined;
  return {
    clicks: gsc?.clicks?.value ?? null,
    impressions: gsc?.impressions?.value ?? null,
    ctr: gsc?.ctr?.value ?? null,
    avgPosition: null,
    prev: {
      clicks: gsc?.clicks?.previous ?? null,
      impressions: gsc?.impressions?.previous ?? null,
      ctr: gsc?.ctr?.previous ?? null,
      avgPosition: null,
    },
    topPages: (gsc ? overview.top_pages : []).slice(0, 10).map((p) => ({ path: p.path, clicks: p.clicks })),
    topKeywords: (keywords?.status === "ok" ? keywords.keywords : []).slice(0, 10).flatMap((k) => {
      const pos = k.avg_position.value;
      if (pos == null || pos <= 0) return [];
      const prev = k.avg_position.previous;
      // Positive change = moved up. Not ranking in the previous period (0/null) = no change shown.
      const change = prev && prev > 0 ? Math.round(prev - pos) : null;
      return [{ keyword: k.keyword, position: Math.max(1, Math.round(pos)), change }];
    }),
  };
}

/** Month snapshot: only the clicks and impressions for that calendar month, when SiteGuru has them. */
export function toMonthMetrics(overview: TrafficOverview): SiteMetrics | null {
  if (overview.status !== "ok" || overview.search_console?.status !== "ok") return null;
  const clicks = overview.search_console.clicks?.value;
  if (clicks == null) return null;
  return { clicks, impressions: overview.search_console.impressions?.value ?? null };
}

/**
 * Maps SiteGuru responses to detection signals. A family is left undefined when its fetch failed or
 * SiteGuru had no data, so detection doesn't treat "no data" as "problem fixed".
 */
export function toSignals(input: {
  todo?: TodoList | null;
  lowHangingFruit?: LowHangingFruit | null;
  declining?: Declining | null;
  cannibalization?: Cannibalization | null;
  overview?: TrafficOverview | null;
  keywords?: TopKeywords | null;
}): Signals {
  const out: Signals = {};
  if (input.todo) {
    out.todo = Object.values(input.todo.todo).flatMap((g) =>
      g.tasks.map((t) => ({
        checkName: t.checkName,
        severity: t.severity,
        title: t.title,
        description: t.description,
        affectedPages: typeof t.affectedPages === "number" ? t.affectedPages : null,
        reportUrl: t.report_url,
      })),
    );
  }
  if (input.lowHangingFruit?.status === "ok") {
    out.lowHangingFruit = input.lowHangingFruit.opportunities.map((o) => ({ keyword: o.keyword, path: o.path, clicks: o.clicks, impressions: o.impressions, avgPosition: o.avg_position }));
  }
  if (input.declining?.data_status === "ok") {
    const months = input.declining.months;
    out.declining = input.declining.pages.map((p) => ({
      path: p.path,
      percentChange: p.percent_change,
      netChange: p.net_change,
      oldestClicks: p.oldest_month_clicks,
      newestClicks: p.newest_month_clicks,
      fromMonth: months[0] ?? "",
      toMonth: months[months.length - 1] ?? "",
    }));
  }
  if (input.cannibalization?.status === "ok") {
    out.cannibalization = input.cannibalization.keywords.map((k) => ({
      keyword: k.keyword,
      impressions: k.impressions.value ?? 0,
      avgPosition: k.avg_position.value,
      pages: k.competing_pages.map((p) => ({ path: p.path, clicks: p.clicks.value ?? 0, avgPosition: p.avg_position.value })),
    }));
  }
  if (input.overview?.status === "ok" && input.overview.search_console?.status === "ok") {
    out.topPages = input.overview.top_pages.flatMap((p) => {
      const rec = p as { path: string; clicks: number; impressions?: number; avg_position?: number };
      return rec.impressions != null && rec.avg_position != null ? [{ path: rec.path, clicks: rec.clicks, impressions: rec.impressions, avgPosition: rec.avg_position }] : [];
    });
  }
  if (input.keywords?.status === "ok") {
    out.keywords = input.keywords.keywords.map((k) => ({ keyword: k.keyword, clicks: k.clicks.value ?? 0, impressions: k.impressions?.value ?? 0, position: k.avg_position.value }));
  }
  return out;
}
