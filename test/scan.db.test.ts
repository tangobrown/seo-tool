// Phase 4 acceptance against Postgres: a scan produces evidence-backed recommendations, a re-run
// doesn't duplicate them, and declined items stay suppressed. Search data comes from a fake
// Search Console; technical to-dos from a finished site audit stored in the database.
import { generateKeyPairSync } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const hasDb = !!process.env.DATABASE_URL;

function fakeSearchConsole(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "tok", expires_in: 3600 });
    if (url.includes("/searchAnalytics/query")) {
      const q = JSON.parse(String(init?.body)) as { dimensions?: string[]; startRow: number };
      if (q.startRow > 0) return json({});
      const dims = (q.dimensions ?? []).join(",");
      if (dims === "date") return json({ rows: [{ keys: ["2026-10-01"], clicks: 40, impressions: 900, ctr: 0.04, position: 9 }] });
      if (dims === "") return json({ rows: [{ keys: [], clicks: 1200, impressions: 40000, ctr: 0.03, position: 11 }] });
      if (dims === "page") return json({ rows: [{ keys: ["https://www.projuice.co.uk/product/acai-puree"], clicks: 200, impressions: 9000, ctr: 0.02, position: 5 }] });
      if (dims === "query") return json({ rows: [{ keys: ["frozen acai"], clicks: 23, impressions: 6867, ctr: 0.003, position: 4.2 }] });
      if (dims === "query,page") {
        return json({ rows: [
          { keys: ["frozen acai", "https://www.projuice.co.uk/product/acai-puree"], clicks: 23, impressions: 6867, ctr: 0.003, position: 4.2 },
          { keys: ["blueberries benefits", "https://www.projuice.co.uk/blog/blueberries"], clicks: 6, impressions: 5802, ctr: 0.001, position: 8.3 },
        ] });
      }
      return json({});
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

describe.skipIf(!hasDb)("opportunity scan", () => {
  let clientId = "";

  beforeAll(async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "scan@test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
    vi.stubGlobal("fetch", fakeSearchConsole());
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
        gscProperty: "sc-domain:projuice.co.uk",
        services: ["Frozen fruit", "Smoothies"],
        priorityServices: ["Frozen fruit"],
        locations: ["Exeter"],
      })
      .returning();
    clientId = c!.id;
    await db.insert(s.siteAudits).values({
      clientId,
      taskId: `scan-test-${Date.now()}`,
      status: "finished",
      finishedAt: new Date(),
      todo: [
        { checkName: "siteMap", severity: "high", title: "XML sitemap", affectedPages: null, description: "The crawler did not find a sitemap for this site." },
        { checkName: "imageAltTags", severity: "low", title: "Images without alt text", affectedPages: 50, description: "Pages: /a, /b." },
        { checkName: "similarContent", severity: "medium", title: "Similar content", affectedPages: 238, description: "Vague." },
      ],
    });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const { inArray } = await import("drizzle-orm");
    const b = await db.select({ id: s.batches.id }).from(s.batches).where(eq(s.batches.clientId, clientId));
    if (b.length) await db.delete(s.executions).where(inArray(s.executions.batchId, b.map((x) => x.id)));
    await db.update(s.opportunities).set({ batchId: null }).where(eq(s.opportunities.clientId, clientId));
    for (const t of [s.batches, s.opportunities, s.siteguruSignals, s.siteAudits, s.serpSnapshots, s.metricSnapshots, s.clientConnections, s.automationRuns, s.auditLog, s.attentionItems] as const) {
      await db.delete(t).where(eq(t.clientId, clientId));
    }
    await db.delete(s.clients).where(eq(s.clients.id, clientId));
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
    expect(recs.some((r) => r.actionKey === "sitemap" && r.severity === "critical" && r.evidence[0]!.source === "dataforseo")).toBe(true);
    expect(recs.some((r) => r.targetQuery === "frozen acai" && r.evidence[0]!.source === "gsc")).toBe(true);
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

  it("a client without Search Console linked produces no signals", async () => {
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const { captureSignals } = await import("@/server/scan");
    await db.update(s.clients).set({ gscProperty: null }).where(eq(s.clients.id, clientId));
    expect(await captureSignals(clientId)).toEqual({ signalsId: null, errors: ["No Search Console property linked"] });
  });
});
