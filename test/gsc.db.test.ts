// Search Console path against Postgres with a fake Google API: daily sync (KPIs + complete months
// only), signals for a scan, detection evidence labelled "Search Console", and reads preferring
// Search Console over SiteGuru.
import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const hasDb = !!process.env.DATABASE_URL;
const NOW = new Date("2026-10-13T08:00:00Z");
const LAST = "2026-10-10"; // Search Console runs ~3 days behind

function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d = new Date(d.getTime() + 86_400_000)) out.push(d.toISOString().slice(0, 10));
  return out;
}

function fakeGoogle(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "tok", expires_in: 3600 });
    if (url.endsWith("/webmasters/v3/sites")) return json({ siteEntry: [{ siteUrl: "sc-domain:gsctest.co.uk", permissionLevel: "siteRestrictedUser" }] });
    if (url.includes("/searchAnalytics/query")) {
      const q = JSON.parse(String(init?.body)) as { startDate: string; endDate: string; dimensions?: string[]; startRow: number };
      if (q.startRow > 0) return json({});
      const ds = days(q.startDate, q.endDate < LAST ? q.endDate : LAST).filter((d) => d >= "2025-09-01");
      const dims = (q.dimensions ?? []).join(",");
      const n = ds.length;
      if (!n) return json({});
      if (dims === "date") return json({ rows: ds.map((d) => ({ keys: [d], clicks: 10, impressions: 200, ctr: 0.05, position: 9 })) });
      if (dims === "") return json({ rows: [{ keys: [], clicks: 10 * n, impressions: 200 * n, ctr: 0.05, position: 9.04 }] });
      if (dims === "page") return json({ rows: [{ keys: ["https://gsctest.co.uk/boiler-repair/"], clicks: 7 * n, impressions: 120 * n, ctr: 0.06, position: 6 }, { keys: ["https://gsctest.co.uk/"], clicks: 3 * n, impressions: 80 * n, ctr: 0.04, position: 12 }] });
      if (dims === "query") return json({ rows: [{ keys: ["boiler repair exeter"], clicks: 5 * n, impressions: 100 * n, ctr: 0.05, position: 8 }] });
      if (dims === "query,page") return json({ rows: [{ keys: ["boiler repair exeter", "https://gsctest.co.uk/boiler-repair"], clicks: 40, impressions: 2400, ctr: 0.016, position: 7.5 }] });
      return json({});
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

describe.skipIf(!hasDb)("Search Console sync and signals", () => {
  let clientId = "";

  beforeAll(async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "seo-autopilot@test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
    vi.stubGlobal("fetch", fakeGoogle());
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const [tier] = await db.select().from(s.tiers).limit(1);
    const [c] = await db
      .insert(s.clients)
      .values({ name: "GSC Test", domain: "gsctest.co.uk", websiteUrl: "https://gsctest.co.uk", tierId: tier!.id, status: "active", gscProperty: "sc-domain:gsctest.co.uk", services: ["Boiler repair"], priorityServices: ["Boiler repair"], locations: ["Exeter"] })
      .returning();
    clientId = c!.id;
    // An older SiteGuru figure for September that Search Console should override.
    await db.insert(s.metricSnapshots).values({ clientId, source: "siteguru", kind: "month", periodStart: new Date("2026-09-01T00:00:00Z"), periodEnd: new Date("2026-09-30T00:00:00Z"), metrics: { clicks: 1, impressions: 1 } });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    for (const t of [s.opportunities, s.siteguruSignals, s.metricSnapshots, s.clientConnections, s.automationRuns, s.auditLog, s.attentionItems] as const) {
      await db.delete(t).where(eq(t.clientId, clientId));
    }
    await db.delete(s.clients).where(eq(s.clients.id, clientId));
  });

  it("syncs the last 30 days and only complete calendar months", async () => {
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const { syncClientFromGsc } = await import("@/server/gsc-sync");
    const out = await syncClientFromGsc(clientId, NOW);
    expect(out.status).toBe("synced");
    const snaps = await db.select().from(s.metricSnapshots).where(eq(s.metricSnapshots.clientId, clientId));
    const rolling = snaps.find((x) => x.source === "gsc" && x.kind === "rolling30")!;
    expect(rolling.metrics).toMatchObject({ clicks: 300, impressions: 6000, ctr: 5, avgPosition: 9 });
    expect(rolling.metrics.topPages?.[0]).toEqual({ path: "/boiler-repair", clicks: 210 });
    const months = snaps.filter((x) => x.source === "gsc" && x.kind === "month").map((x) => x.periodStart.toISOString().slice(0, 7)).sort();
    expect(months).toEqual(["2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]); // October is incomplete
    const [conn] = await db.select().from(s.clientConnections).where(eq(s.clientConnections.clientId, clientId));
    expect(conn).toMatchObject({ provider: "gsc", status: "connected" });
  });

  it("prefers Search Console over SiteGuru for the month and the Reports tab", async () => {
    const { monthMetrics } = await import("@/server/reports");
    const { getReportsOverview } = await import("@/server/queries");
    expect((await monthMetrics(clientId, "2026-09"))?.clicks).toBe(300);
    const o = await getReportsOverview(clientId);
    expect(o.rolling?.clicks).toBe(300);
    expect(o.months.find((m) => m.periodStart.toISOString().startsWith("2026-09"))?.metrics.clicks).toBe(300);
  });

  it("captures scan signals from Search Console and labels the evidence", async () => {
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const { captureSignals, runDetection } = await import("@/server/scan");
    const sig = await captureSignals(clientId);
    const [row] = await db.select().from(s.siteguruSignals).where(eq(s.siteguruSignals.id, sig.signalsId!));
    expect(row!.source).toBe("gsc");
    const signals = row!.signals as { lowHangingFruit: unknown[]; sources: unknown };
    expect(signals.lowHangingFruit).toHaveLength(1);
    expect(signals.sources).toEqual({ search: "gsc" });
    await runDetection(clientId, sig.signalsId, NOW);
    const opps = await db.select().from(s.opportunities).where(eq(s.opportunities.clientId, clientId));
    const rank = opps.find((o) => o.actionKey === "rank")!;
    expect(rank.targetQuery).toBe("boiler repair exeter");
    expect(rank.evidence[0]!.source).toBe("gsc");
  });
});
