// End to end against Postgres: SiteGuru (mock MCP server) → metric_snapshots → connection health.
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockMcp } from "./helpers/mock-mcp";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("SiteGuru sync", () => {
  let mock: Awaited<ReturnType<typeof startMockMcp>>;
  let clientId = "";

  beforeAll(async () => {
    mock = await startMockMcp();
    process.env.SITEGURU_MCP_URL = mock.url;
    process.env.SITEGURU_API_KEY = "test-key";
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const [tier] = await db.select().from(s.tiers).limit(1);
    const [c] = await db
      .insert(s.clients)
      .values({ name: "Sync Test", domain: "projuice.co.uk", websiteUrl: "https://projuice.co.uk", tierId: tier!.id, status: "active", siteguruSiteId: "https://www.projuice.co.uk" })
      .returning();
    clientId = c!.id;
    await db.insert(s.clientConnections).values({ clientId, provider: "siteguru", status: "pending" });
  });

  afterAll(async () => {
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    await db.delete(s.metricSnapshots).where(eq(s.metricSnapshots.clientId, clientId));
    await db.delete(s.clientConnections).where(eq(s.clientConnections.clientId, clientId));
    await db.delete(s.automationRuns).where(eq(s.automationRuns.clientId, clientId));
    await db.delete(s.clients).where(eq(s.clients.id, clientId));
    await mock.close();
  });

  it("stores the rolling snapshot, cached months only, and marks the connection healthy", async () => {
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const { syncClientFromSiteguru } = await import("@/server/siteguru-sync");
    const now = new Date("2026-10-04T05:00:00Z");

    const out = await syncClientFromSiteguru(clientId, now);
    expect(out).toMatchObject({ status: "synced", months: 1 });
    // Running it again must not duplicate month snapshots.
    await syncClientFromSiteguru(clientId, now);

    const snaps = await db.select().from(s.metricSnapshots).where(eq(s.metricSnapshots.clientId, clientId));
    const months = snaps.filter((x) => x.kind === "month");
    expect(months).toHaveLength(1);
    expect(months[0]!.periodStart.toISOString().slice(0, 10)).toBe("2026-09-01");
    expect(months[0]!.metrics.clicks).toBe(2900);
    const rolling = snaps.filter((x) => x.kind === "rolling30");
    expect(rolling[0]!.metrics.clicks).toBe(2816);
    expect(rolling[0]!.metrics.avgPosition).toBeNull();

    const [conn] = await db
      .select()
      .from(s.clientConnections)
      .where(and(eq(s.clientConnections.clientId, clientId), eq(s.clientConnections.provider, "siteguru")));
    expect(conn!.status).toBe("connected");
    expect(conn!.lastSuccessAt).not.toBeNull();
  });

  it("records a failure on the connection and raises one aggregate attention item", async () => {
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const { syncClientFromSiteguru } = await import("@/server/siteguru-sync");
    process.env.SITEGURU_API_KEY = "revoked-key";
    await expect(syncClientFromSiteguru(clientId)).rejects.toThrow(/rejected the API key/);
    process.env.SITEGURU_API_KEY = "test-key";

    const [conn] = await db
      .select()
      .from(s.clientConnections)
      .where(and(eq(s.clientConnections.clientId, clientId), eq(s.clientConnections.provider, "siteguru")));
    expect(conn!.status).toBe("error");
    const [item] = await db.select().from(s.attentionItems).where(eq(s.attentionItems.dedupeKey, "siteguru_sync_failing"));
    expect(item!.status).toBe("open");
    expect(item!.title).toMatch(/SiteGuru sync failing for \d+ client/);

    // Recovery resolves it.
    await syncClientFromSiteguru(clientId);
    const [after] = await db.select().from(s.attentionItems).where(eq(s.attentionItems.dedupeKey, "siteguru_sync_failing"));
    expect(after!.status).toBe("resolved");
  });
});
