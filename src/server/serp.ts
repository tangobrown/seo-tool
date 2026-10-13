import "server-only";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { db } from "@/db";
import { clients, serpSnapshots } from "@/db/schema";
import { competitors, positionChange, trackedQueries, type SerpResult } from "@/domain/serp";

export async function storeSerpResults(clientId: string, results: SerpResult[], capturedAt = new Date()) {
  if (!results.length) return;
  await db.insert(serpSnapshots).values(
    results.map((r) => ({
      clientId,
      query: r.query,
      location: r.location,
      capturedAt,
      clientOrganicPosition: r.organicPosition,
      clientLocalPosition: r.localPosition,
      organic: { service: r.service, organicUrl: r.organicUrl, items: r.organic },
      localPack: r.local,
    })),
  );
}

type OrganicJson = { service?: string; organicUrl?: string | null; items?: SerpResult["organic"] };

function toResult(row: typeof serpSnapshots.$inferSelect): SerpResult {
  const o = (row.organic ?? {}) as OrganicJson;
  return {
    query: row.query,
    service: o.service ?? row.query,
    location: row.location,
    organicPosition: row.clientOrganicPosition,
    organicUrl: o.organicUrl ?? null,
    localPosition: row.clientLocalPosition,
    organic: o.items ?? [],
    local: (row.localPack ?? []) as SerpResult["local"],
  };
}

/** The newest result for each currently tracked search (older searches the client no longer tracks are ignored). */
export async function latestSerpResults(clientId: string, before?: Date): Promise<SerpResult[]> {
  const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!c) return [];
  const tracked = new Set(trackedQueries(c, 1000).map((q) => q.query));
  const rows = await db
    .selectDistinctOn([serpSnapshots.query])
    .from(serpSnapshots)
    .where(and(eq(serpSnapshots.clientId, clientId), before ? lt(serpSnapshots.capturedAt, before) : undefined))
    .orderBy(serpSnapshots.query, desc(serpSnapshots.capturedAt));
  return rows.filter((r) => tracked.has(r.query)).map(toResult);
}

export type LocalVisibilityRow = {
  service: string;
  location: string;
  query: string;
  localPosition: number | null;
  localChange: number | null;
  organicPosition: number | null;
  organicChange: number | null;
  checkedAt: Date;
};

/**
 * Reports tab "Local visibility" (§7.6): latest map and organic positions per service × town, with
 * the change against the newest check at least 28 days older. Empty when nothing has been tracked.
 */
export async function getLocalVisibility(clientId: string): Promise<{ rows: LocalVisibilityRow[]; competitors: ReturnType<typeof competitors> }> {
  const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!c) return { rows: [], competitors: [] };
  const latest = await db
    .selectDistinctOn([serpSnapshots.query])
    .from(serpSnapshots)
    .where(eq(serpSnapshots.clientId, clientId))
    .orderBy(serpSnapshots.query, desc(serpSnapshots.capturedAt));
  if (!latest.length) return { rows: [], competitors: [] };
  const newest = latest.reduce((m, r) => (r.capturedAt > m ? r.capturedAt : m), latest[0]!.capturedAt);
  const earlier = await db
    .selectDistinctOn([serpSnapshots.query])
    .from(serpSnapshots)
    .where(and(eq(serpSnapshots.clientId, clientId), lt(serpSnapshots.capturedAt, new Date(newest.getTime() - 28 * 86_400_000)), gte(serpSnapshots.capturedAt, new Date(newest.getTime() - 60 * 86_400_000))))
    .orderBy(serpSnapshots.query, desc(serpSnapshots.capturedAt));
  const before = new Map(earlier.map((r) => [r.query, r]));
  const order = new Map(trackedQueries(c, 1000).map((q, i) => [q.query, i]));
  const results = latest.filter((r) => order.has(r.query)).map(toResult);
  const rows = latest
    .filter((r) => order.has(r.query))
    .sort((a, b) => order.get(a.query)! - order.get(b.query)!)
    .map((r) => {
      const res = toResult(r);
      const b = before.get(r.query);
      return {
        service: res.service,
        location: res.location,
        query: r.query,
        localPosition: r.clientLocalPosition,
        localChange: positionChange(r.clientLocalPosition, b?.clientLocalPosition ?? null),
        organicPosition: r.clientOrganicPosition,
        organicChange: positionChange(r.clientOrganicPosition, b?.clientOrganicPosition ?? null),
        checkedAt: r.capturedAt,
      };
    });
  return { rows, competitors: competitors(results, c.domain, 5) };
}
