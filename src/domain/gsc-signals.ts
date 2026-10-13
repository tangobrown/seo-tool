// Detection signals computed from Google Search Console rows. Pure functions: the sync fetches the
// rows, these turn them into the same Signals shape the opportunity rules already read.

import type { SiteMetrics } from "@/db/schema";
import type { Signals } from "./opportunities/types";

export type GscRow = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };

/** "https://www.example.co.uk/boiler-repair/?x=1#y" → "/boiler-repair" */
export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/\/+$/, "");
    return p || "/";
  } catch {
    return url;
  }
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Site totals for one window → KPI metrics. GSC CTR is a fraction; SiteMetrics stores a percentage. */
export function totalsToMetrics(curr: GscRow | undefined, prev: GscRow | undefined): Pick<SiteMetrics, "clicks" | "impressions" | "ctr" | "avgPosition" | "prev"> {
  const m = (r: GscRow | undefined) =>
    r ? { clicks: r.clicks, impressions: r.impressions, ctr: round1(r.ctr * 100), avgPosition: round1(r.position) } : { clicks: 0, impressions: 0, ctr: null, avgPosition: null };
  return { ...m(curr), prev: m(prev) };
}

/** Rows with dimensions [page] → top pages, merging URLs that differ only by trailing slash or query. */
export function topPagesFrom(rows: GscRow[], limit = 50): NonNullable<Signals["topPages"]> {
  const by = new Map<string, { clicks: number; impressions: number; posWeighted: number }>();
  for (const r of rows) {
    const path = pathOf(r.keys[0] ?? "");
    const e = by.get(path) ?? { clicks: 0, impressions: 0, posWeighted: 0 };
    e.clicks += r.clicks;
    e.impressions += r.impressions;
    e.posWeighted += r.position * r.impressions;
    by.set(path, e);
  }
  return [...by.entries()]
    .map(([path, e]) => ({ path, clicks: e.clicks, impressions: e.impressions, avgPosition: e.impressions ? round1(e.posWeighted / e.impressions) : 0 }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
    .slice(0, limit);
}

/** Rows with dimensions [query] → keyword demand. */
export function keywordsFrom(rows: GscRow[], limit = 500): NonNullable<Signals["keywords"]> {
  return rows
    .map((r) => ({ keyword: r.keys[0] ?? "", clicks: r.clicks, impressions: r.impressions, position: round1(r.position) }))
    .filter((k) => k.keyword)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limit);
}

/**
 * Rows with dimensions [query, page] over 90 days → near misses: queries where a page ranks
 * 4–20. The opportunity rule applies its own, stricter thresholds on top.
 */
export function lowHangingFruitFrom(rows: GscRow[]): NonNullable<Signals["lowHangingFruit"]> {
  return rows
    .filter((r) => r.position >= 4 && r.position <= 20 && r.impressions >= 50)
    .map((r) => ({ keyword: r.keys[0] ?? "", path: pathOf(r.keys[1] ?? ""), clicks: r.clicks, impressions: r.impressions, avgPosition: round1(r.position) }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 500);
}

/**
 * Rows with dimensions [query, page] over 90 days → queries where two or more pages each earn a
 * real share (≥ 20 impressions and ≥ 10% of the query's impressions).
 */
export function cannibalizationFrom(rows: GscRow[]): NonNullable<Signals["cannibalization"]> {
  const byQuery = new Map<string, GscRow[]>();
  for (const r of rows) {
    const q = r.keys[0] ?? "";
    if (!q) continue;
    const list = byQuery.get(q) ?? [];
    list.push(r);
    byQuery.set(q, list);
  }
  const out: NonNullable<Signals["cannibalization"]> = [];
  for (const [keyword, list] of byQuery) {
    const total = list.reduce((s, r) => s + r.impressions, 0);
    const pages = new Map<string, { clicks: number; impressions: number; posWeighted: number }>();
    for (const r of list) {
      const path = pathOf(r.keys[1] ?? "");
      const e = pages.get(path) ?? { clicks: 0, impressions: 0, posWeighted: 0 };
      e.clicks += r.clicks;
      e.impressions += r.impressions;
      e.posWeighted += r.position * r.impressions;
      pages.set(path, e);
    }
    const competing = [...pages.entries()].filter(([, e]) => e.impressions >= 20 && e.impressions >= total * 0.1);
    if (competing.length < 2) continue;
    const posWeighted = list.reduce((s, r) => s + r.position * r.impressions, 0);
    out.push({
      keyword,
      impressions: total,
      avgPosition: total ? round1(posWeighted / total) : null,
      pages: competing
        .map(([path, e]) => ({ path, clicks: e.clicks, avgPosition: e.impressions ? round1(e.posWeighted / e.impressions) : null }))
        .sort((a, b) => b.clicks - a.clicks),
    });
  }
  return out.sort((a, b) => b.impressions - a.impressions).slice(0, 100);
}

/**
 * Per-page clicks for each of the last complete months (oldest first, "YYYY-MM" → rows with
 * dimensions [page]) → pages whose clicks fell from the oldest month to the newest.
 */
export function decliningFrom(months: { month: string; rows: GscRow[] }[]): NonNullable<Signals["declining"]> {
  if (months.length < 2) return [];
  const oldest = months[0]!;
  const newest = months[months.length - 1]!;
  const sum = (rows: GscRow[]) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const p = pathOf(r.keys[0] ?? "");
      m.set(p, (m.get(p) ?? 0) + r.clicks);
    }
    return m;
  };
  const a = sum(oldest.rows);
  const b = sum(newest.rows);
  const out: NonNullable<Signals["declining"]> = [];
  for (const [path, oldestClicks] of a) {
    if (oldestClicks <= 0) continue;
    const newestClicks = b.get(path) ?? 0;
    const netChange = newestClicks - oldestClicks;
    if (netChange >= 0) continue;
    out.push({ path, oldestClicks, newestClicks, netChange, percentChange: round1((netChange / oldestClicks) * 100), fromMonth: oldest.month, toMonth: newest.month });
  }
  return out.sort((x, y) => x.netChange - y.netChange).slice(0, 100);
}

/**
 * Rows with dimensions [date] → calendar-month totals. A month counts only when the data
 * covers its first and last days (GSC lags 2–3 days), so a report never uses a part-month as a full one.
 */
export function monthlyTotals(rows: GscRow[]): { month: string; clicks: number; impressions: number; complete: boolean }[] {
  const by = new Map<string, { clicks: number; impressions: number }>();
  let first = "9999";
  let last = "";
  for (const r of rows) {
    const d = r.keys[0] ?? "";
    if (d > last) last = d;
    if (d < first) first = d;
    const m = d.slice(0, 7);
    const e = by.get(m) ?? { clicks: 0, impressions: 0 };
    e.clicks += r.clicks;
    e.impressions += r.impressions;
    by.set(m, e);
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, e]) => {
      const [y, mm] = month.split("-").map(Number) as [number, number];
      const lastDay = new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10);
      // The first month of the window may start part-way through.
      return { month, ...e, complete: last >= lastDay && first <= `${month}-01` };
    });
}

/**
 * The client's Search Console property among those shared with us. A Domain property
 * ("sc-domain:example.co.uk") covers every version of the site, so it wins over URL-prefix ones.
 */
export function matchGscProperty(sites: { siteUrl: string }[], domain: string): string | null {
  const bare = domain.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  const urls = sites.map((s) => s.siteUrl);
  const exact = urls.find((u) => u.toLowerCase() === `sc-domain:${bare}`);
  if (exact) return exact;
  const prefixes = [`https://www.${bare}/`, `https://${bare}/`, `http://www.${bare}/`, `http://${bare}/`];
  for (const p of prefixes) {
    const hit = urls.find((u) => u.toLowerCase() === p);
    if (hit) return hit;
  }
  return null;
}
