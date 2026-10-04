// Phase 4 acceptance against Postgres: a scan produces evidence-backed recommendations, a re-run
// doesn't duplicate them, and declined items stay suppressed. SiteGuru is the mock MCP server.
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockMcp } from "./helpers/mock-mcp";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("opportunity scan", () => {
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
      .values({
        name: "Scan Test",
        domain: "projuice.co.uk",
        websiteUrl: "https://projuice.co.uk",
        tierId: tier!.id,
        status: "active",
        siteguruSiteId: "https://www.projuice.co.uk",
        services: ["Frozen fruit", "Smoothies"],
        priorityServices: ["Frozen fruit"],
        locations: ["Exeter"],
      })
      .returning();
    clientId = c!.id;
    await db.insert(s.clientConnections).values({ clientId, provider: "siteguru", status: "connected" });
  });

  afterAll(async () => {
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const { inArray } = await import("drizzle-orm");
    const b = await db.select({ id: s.batches.id }).from(s.batches).where(eq(s.batches.clientId, clientId));
    if (b.length) await db.delete(s.executions).where(inArray(s.executions.batchId, b.map((x) => x.id)));
    await db.update(s.opportunities).set({ batchId: null }).where(eq(s.opportunities.clientId, clientId));
    for (const t of [s.batches, s.opportunities, s.siteguruSignals, s.metricSnapshots, s.clientConnections, s.automationRuns, s.auditLog, s.attentionItems] as const) {
      await db.delete(t).where(eq(t.clientId, clientId));
    }
    await db.delete(s.clients).where(eq(s.clients.id, clientId));
    await mock.close();
  });

  async function scan() {
    const { captureSignals, runDetection } = await import("@/server/scan");
    const sig = await captureSignals(clientId);
    expect(sig.errors).toEqual([]);
    return runDetection(clientId, sig.signalsId, new Date("2026-10-05T06:00:00Z"));
  }

  it("produces evidence-backed recommendations, critical first", async () => {
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const out = await scan();
    expect(out.recommended).toBeGreaterThan(0);
    expect(out.recommended).toBeLessThanOrEqual(10);
    const recs = await db.select().from(s.opportunities).where(and(eq(s.opportunities.clientId, clientId), eq(s.opportunities.status, "recommended")));
    expect(recs.every((r) => r.evidence.length > 0)).toBe(true);
    expect(recs.every((r) => r.severity === "critical" || r.priorityScore >= 65)).toBe(true); // never padded
    expect(recs.some((r) => r.actionKey === "sitemap" && r.severity === "critical")).toBe(true);
    expect(recs.some((r) => r.targetQuery === "frozen acai")).toBe(true);
    expect(recs.some((r) => r.title.toLowerCase().includes("similar"))).toBe(false); // vague to-dos ignored
  });

  it("re-running the scan doesn't duplicate anything", async () => {
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const before = await db.select().from(s.opportunities).where(eq(s.opportunities.clientId, clientId));
    const out = await scan();
    const after = await db.select().from(s.opportunities).where(eq(s.opportunities.clientId, clientId));
    expect(out.inserted).toBe(0);
    expect(out.newlyRecommended).toEqual([]);
    expect(after).toHaveLength(before.length);
  });

  it("declined items stay suppressed on the next scan", async () => {
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const [acai] = await db.select().from(s.opportunities).where(and(eq(s.opportunities.clientId, clientId), eq(s.opportunities.targetQuery, "frozen acai")));
    await db.update(s.opportunities).set({ status: "declined", decidedAt: new Date("2026-10-04T00:00:00Z"), decidedBy: "operator", scoreAtDecision: acai!.priorityScore }).where(eq(s.opportunities.id, acai!.id));
    await scan();
    const [after] = await db.select().from(s.opportunities).where(eq(s.opportunities.id, acai!.id));
    expect(after!.status).toBe("declined");
  });

  it("auto-approves only alt text, schema and image compression, as a PR batch", async () => {
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const { autoApproveLowImpact } = await import("@/server/scan");
    await db.update(s.clients).set({ autoApproveLowImpact: true }).where(eq(s.clients.id, clientId));
    const res = await autoApproveLowImpact(clientId, "test-scan");
    const approved = await db.select().from(s.opportunities).where(and(eq(s.opportunities.clientId, clientId), eq(s.opportunities.status, "approved")));
    if (res) {
      expect(approved.every((o) => ["alt_text", "schema", "page_speed"].includes(o.actionKey ?? ""))).toBe(true);
      const [b] = await db.select().from(s.batches).where(eq(s.batches.id, res.batchId));
      expect(b!.createdBy).toBe("auto");
    } else {
      expect(approved).toHaveLength(0); // nothing eligible was recommended
    }
  });
});
