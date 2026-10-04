import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { clientConnections, clients, metricSnapshots } from "@/db/schema";
import { siteguru } from "@/integrations/siteguru";
import { toMonthMetrics, toRollingMetrics } from "@/integrations/siteguru/map";
import { notify, appLink } from "@/integrations/slack";
import { raiseAttention, resolveAttention } from "@/lib/attention";

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

export type SyncOutcome = { status: "synced" | "skipped"; message: string; months: number };

/**
 * Syncs one client from SiteGuru into metric_snapshots. The UI only ever reads these snapshots.
 * Throws on provider failure (after recording it on the client's connection) so the job retries.
 */
export async function syncClientFromSiteguru(clientId: string, now = new Date()): Promise<SyncOutcome> {
  const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!c) throw new Error(`Client ${clientId} not found`);
  if (!c.siteguruSiteId) return { status: "skipped", message: "No SiteGuru site linked", months: 0 };
  const site = c.siteguruSiteId;

  try {
    const overview = await siteguru.trafficOverview(site, { range: "last_30_days" });
    let months = 0;
    if (overview.status === "ok") {
      const keywords = await siteguru.topKeywords(site, { range: "last_30_days" });
      const start = overview.data_period ? new Date(`${overview.data_period.start}T00:00:00Z`) : new Date(now.getTime() - 30 * 86400_000);
      const end = overview.data_period ? new Date(`${overview.data_period.end}T00:00:00Z`) : now;
      await db.insert(metricSnapshots).values({
        clientId,
        source: "siteguru",
        kind: "rolling30",
        periodStart: start,
        periodEnd: end,
        metrics: toRollingMetrics(overview, keywords),
      });

      // Monthly history: the last 3 full calendar months, if SiteGuru has them cached. Older months
      // aren't fetchable over the API, so history builds up from these snapshots over time.
      for (let back = 1; back <= 3; back++) {
        const mStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
        const mEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back + 1, 0));
        const m = toMonthMetrics(await siteguru.trafficOverview(site, { start: ymd(mStart), end: ymd(mEnd) }));
        if (!m) continue;
        await db
          .insert(metricSnapshots)
          .values({ clientId, source: "siteguru", kind: "month", periodStart: mStart, periodEnd: mEnd, metrics: m })
          .onConflictDoUpdate({
            target: [metricSnapshots.clientId, metricSnapshots.source, metricSnapshots.kind, metricSnapshots.periodStart],
            targetWhere: sql`kind = 'month'`,
            set: { metrics: m, capturedAt: new Date() },
          });
        months++;
      }
    }

    await db
      .update(clientConnections)
      .set({ status: "connected", externalId: site, lastSuccessAt: new Date(), lastError: null })
      .where(and(eq(clientConnections.clientId, clientId), eq(clientConnections.provider, "siteguru")));
    await refreshSyncFailureAttention();
    const gscMissing = overview.status === "ok" && overview.search_console?.status !== "ok";
    return {
      status: "synced",
      months,
      message: overview.status !== "ok" ? "SiteGuru has no data cached yet" : gscMissing ? "Synced (Search Console not connected in SiteGuru)" : "Synced",
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db
      .update(clientConnections)
      .set({ status: "error", lastFailureAt: new Date(), lastError: message.slice(0, 500) })
      .where(and(eq(clientConnections.clientId, clientId), eq(clientConnections.provider, "siteguru")));
    await refreshSyncFailureAttention();
    throw e;
  }
}

/** One aggregate attention item: "SiteGuru sync failing for N clients". Resolves itself at zero. */
export async function refreshSyncFailureAttention() {
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(clientConnections)
    .innerJoin(clients, eq(clients.id, clientConnections.clientId))
    .where(and(eq(clientConnections.provider, "siteguru"), eq(clientConnections.status, "error"), sql`${clients.archivedAt} is null`));
  if (n > 0) {
    await raiseAttention({
      dedupeKey: "siteguru_sync_failing",
      kind: "integration",
      title: `SiteGuru sync failing for ${n} client${n === 1 ? "" : "s"}`,
      detail: "Check the SiteGuru key and each client’s SiteGuru site in Connections.",
      link: "/settings/integrations",
    });
  } else {
    await resolveAttention("siteguru_sync_failing");
  }
}

export async function notifySyncFailure(message: string) {
  await notify("failures", `:warning: SiteGuru sync failed: ${message.slice(0, 160)} ${appLink("/settings/integrations", "Open")}`);
}
