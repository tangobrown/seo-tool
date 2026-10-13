import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { clientConnections, clients, metricSnapshots, type SiteMetrics } from "@/db/schema";
import {
  cannibalizationFrom,
  decliningFrom,
  keywordsFrom,
  lowHangingFruitFrom,
  monthlyTotals,
  topPagesFrom,
  totalsToMetrics,
  type GscRow,
} from "@/domain/gsc-signals";
import type { Signals } from "@/domain/opportunities/types";
import { gsc } from "@/integrations/gsc";
import { raiseAttention, resolveAttention } from "@/lib/attention";

const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);

/**
 * The latest day Search Console has final data for. It usually lags 2–3 days; we look back over
 * the last 10 days and take the newest day with a row.
 */
async function lastDataDay(property: string, now: Date): Promise<Date | null> {
  const rows = await gsc.query(property, { startDate: ymd(addDays(now, -10)), endDate: ymd(now), dimensions: ["date"] });
  const last = rows.map((r) => r.keys[0] ?? "").sort().at(-1);
  return last ? new Date(`${last}T00:00:00Z`) : null;
}

export type GscSyncOutcome = { status: "synced" | "skipped"; message: string; months: number };

/**
 * Daily KPI sync from Search Console: the last 30 days vs the 30 before (with top pages and
 * keywords), and every complete calendar month in the last 16 months.
 */
export async function syncClientFromGsc(clientId: string, now = new Date()): Promise<GscSyncOutcome> {
  const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!c) throw new Error(`Client ${clientId} not found`);
  const property = c.gscProperty;
  if (!property) return { status: "skipped", message: "No Search Console property linked", months: 0 };

  try {
    const end = await lastDataDay(property, now);
    if (!end) {
      await setGscConnection(clientId, { status: "connected", lastSuccessAt: new Date(), lastError: "No search data yet" });
      return { status: "synced", message: "Connected, but Search Console has no data for the last 10 days", months: 0 };
    }
    const start = addDays(end, -29);
    const prevEnd = addDays(start, -1);
    const prevStart = addDays(prevEnd, -29);
    const win = (s: Date, e: Date) => ({ startDate: ymd(s), endDate: ymd(e) });

    const [[curr], [prev], pagesRows, kwRows, prevKwRows, days] = await Promise.all([
      gsc.query(property, win(start, end)),
      gsc.query(property, win(prevStart, prevEnd)),
      gsc.query(property, { ...win(start, end), dimensions: ["page"] }, 5_000),
      gsc.query(property, { ...win(start, end), dimensions: ["query"] }, 5_000),
      gsc.query(property, { ...win(prevStart, prevEnd), dimensions: ["query"] }, 5_000),
      // 16 months is everything Search Console keeps.
      gsc.query(property, { startDate: ymd(new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 16, 1))), endDate: ymd(end), dimensions: ["date"] }),
    ]);

    const prevPos = new Map(prevKwRows.map((r) => [r.keys[0] ?? "", r.position]));
    const metrics: SiteMetrics = {
      ...totalsToMetrics(curr, prev),
      topPages: topPagesFrom(pagesRows, 10).map((p) => ({ path: p.path, clicks: p.clicks })),
      topKeywords: keywordsFrom(kwRows, 5_000)
        .sort((a, b) => b.clicks - a.clicks)
        .slice(0, 10)
        .map((k) => {
          const before = prevPos.get(k.keyword);
          // Positive change = moved up.
          return { keyword: k.keyword, position: Math.round(k.position ?? 0), change: before != null ? Math.round(before) - Math.round(k.position ?? 0) : null };
        }),
    };
    await db.insert(metricSnapshots).values({ clientId, source: "gsc", kind: "rolling30", periodStart: start, periodEnd: end, metrics });

    let months = 0;
    for (const m of monthlyTotals(days).filter((x) => x.complete)) {
      const [y, mm] = m.month.split("-").map(Number) as [number, number];
      const mStart = new Date(Date.UTC(y, mm - 1, 1));
      const mEnd = new Date(Date.UTC(y, mm, 0));
      const value: SiteMetrics = { clicks: m.clicks, impressions: m.impressions };
      await db
        .insert(metricSnapshots)
        .values({ clientId, source: "gsc", kind: "month", periodStart: mStart, periodEnd: mEnd, metrics: value })
        .onConflictDoUpdate({
          target: [metricSnapshots.clientId, metricSnapshots.source, metricSnapshots.kind, metricSnapshots.periodStart],
          targetWhere: sql`kind = 'month'`,
          set: { metrics: value, capturedAt: new Date() },
        });
      months++;
    }

    await setGscConnection(clientId, { status: "connected", lastSuccessAt: new Date(), lastError: null });
    await resolveAttention(`gsc_sync:${clientId}`);
    return { status: "synced", message: "Synced", months };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await setGscConnection(clientId, { status: "error", lastFailureAt: new Date(), lastError: message.slice(0, 500) });
    await raiseAttention({
      dedupeKey: `gsc_sync:${clientId}`,
      kind: "integration",
      clientId,
      title: `Search Console sync failed for ${c.name}`,
      detail: /403|permission/i.test(message)
        ? "The service account isn’t a user on this Search Console property. Add it under Settings → Users and permissions in Search Console."
        : message.slice(0, 200),
      link: `/clients/${clientId}/settings`,
    });
    throw e;
  }
}

async function setGscConnection(clientId: string, set: Partial<typeof clientConnections.$inferInsert>) {
  const [c] = await db.select({ property: clients.gscProperty }).from(clients).where(eq(clients.id, clientId));
  await db
    .insert(clientConnections)
    .values({ clientId, provider: "gsc", externalId: c?.property ?? null, status: "pending", ...set })
    .onConflictDoUpdate({ target: [clientConnections.clientId, clientConnections.provider], set: { externalId: c?.property ?? null, ...set } });
}

/**
 * Detection signals from Search Console for a scan: near misses and competing pages over the last
 * 90 days, top pages and keywords over 30 days, and pages declining across the last 6 complete months.
 */
export async function gscSignals(property: string, now = new Date()): Promise<Pick<Signals, "lowHangingFruit" | "cannibalization" | "topPages" | "keywords" | "declining">> {
  const end = (await lastDataDay(property, now)) ?? addDays(now, -3);
  const win = (days: number) => ({ startDate: ymd(addDays(end, -(days - 1))), endDate: ymd(end) });
  const [qp90, pages30, kw30] = await Promise.all([
    gsc.query(property, { ...win(90), dimensions: ["query", "page"] }),
    gsc.query(property, { ...win(30), dimensions: ["page"] }, 5_000),
    gsc.query(property, { ...win(30), dimensions: ["query"] }, 5_000),
  ]);

  // Last 6 complete calendar months. The month containing `end` is incomplete unless end is its last day.
  const endIsMonthEnd = addDays(end, 1).getUTCDate() === 1;
  const lastComplete = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (endIsMonthEnd ? 0 : 1), 1));
  const monthsBack: { month: string; start: Date; finish: Date }[] = [];
  for (let i = 5; i >= 0; i--) {
    const s = new Date(Date.UTC(lastComplete.getUTCFullYear(), lastComplete.getUTCMonth() - i, 1));
    const f = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 0));
    monthsBack.push({ month: ymd(s).slice(0, 7), start: s, finish: f });
  }
  const oldest = monthsBack[0]!;
  const newest = monthsBack[monthsBack.length - 1]!;
  const [oldRows, newRows] = await Promise.all(
    [oldest, newest].map((m) => gsc.query(property, { startDate: ymd(m.start), endDate: ymd(m.finish), dimensions: ["page"] }, 5_000)),
  );
  const months: { month: string; rows: GscRow[] }[] = [
    { month: oldest.month, rows: oldRows! },
    { month: newest.month, rows: newRows! },
  ];

  return {
    lowHangingFruit: lowHangingFruitFrom(qp90),
    cannibalization: cannibalizationFrom(qp90),
    topPages: topPagesFrom(pages30),
    keywords: keywordsFrom(kw30),
    declining: decliningFrom(months),
  };
}

/** Clients that read search data from Search Console rather than SiteGuru. */
export async function usesGsc(clientId: string): Promise<boolean> {
  const [c] = await db.select({ p: clients.gscProperty }).from(clients).where(eq(clients.id, clientId));
  return !!c?.p;
}

export async function gscConnectionOk(clientId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: clientConnections.status })
    .from(clientConnections)
    .where(and(eq(clientConnections.clientId, clientId), eq(clientConnections.provider, "gsc")));
  return row?.status === "connected";
}
