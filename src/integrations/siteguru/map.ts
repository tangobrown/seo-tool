import type { SiteMetrics } from "@/db/schema";
import type { SiteguruSiteRaw, TopKeywords, TrafficOverview } from "./schemas";

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
