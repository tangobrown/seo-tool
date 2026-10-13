// DataForSEO path against Postgres with a fake API: town → location code, posting tracked searches,
// a queued result being retried, storing results, the Local visibility table, and a site crawl
// turning into to-do items.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const hasDb = !!process.env.DATABASE_URL;

function fakeDfs() {
  let organicPolls = 0;
  const ok = (tasks: unknown[]) => new Response(JSON.stringify({ status_code: 20000, status_message: "Ok.", cost: 0.0012, tasks }), { status: 200 });
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("pagespeedonline")) {
      return new Response(JSON.stringify({ lighthouseResult: { categories: { performance: { score: 0.42 } }, audits: { "largest-contentful-paint": { numericValue: 4800 } } } }), { status: 200 });
    }
    const path = url.replace("https://api.dataforseo.com/v3", "");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>[]) : [];
    if (path === "/serp/google/locations/gb") {
      return ok([{ status_code: 20000, result: [
        { location_code: 1006528, location_name: "Exeter,England,United Kingdom", location_type: "City" },
        { location_code: 20339, location_name: "England,United Kingdom", location_type: "Region" },
      ] }]);
    }
    const post = path.match(/^\/serp\/google\/(organic|maps)\/task_post$/);
    if (post) return ok(body.map((b, i) => ({ id: `${post[1]}-${i}`, status_code: 20100, cost: 0.0006, data: { tag: b.tag }, result: null })));
    if (path.startsWith("/serp/google/organic/task_get/advanced/")) {
      organicPolls++;
      if (organicPolls === 1) return ok([{ status_code: 40602, status_message: "Task In Queue." }]);
      return ok([{ id: "x", status_code: 20000, result: [{ items: [
        { type: "organic", rank_group: 1, domain: "rival.co.uk", url: "https://rival.co.uk/", title: "Rival" },
        { type: "organic", rank_group: 13, domain: "www.dfstest.co.uk", url: "https://www.dfstest.co.uk/boiler-repair/", title: "Boiler repair" },
      ] }] }]);
    }
    if (path.startsWith("/serp/google/maps/task_get/advanced/")) {
      return ok([{ id: "y", status_code: 20000, result: [{ items: [
        { type: "maps_search", rank_group: 1, title: "Rival Heating", domain: "rival.co.uk", rating: { value: 4.8 } },
        { type: "maps_search", rank_group: 2, title: "Other", domain: null },
        { type: "maps_search", rank_group: 3, title: "Third", domain: "third.co.uk" },
        { type: "maps_search", rank_group: 5, title: "DFS Test", domain: "dfstest.co.uk" },
      ] }] }]);
    }
    if (path === "/on_page/task_post") return ok([{ id: "crawl-1", status_code: 20100, cost: 0.075, result: null }]);
    if (path === "/on_page/summary/crawl-1") {
      return ok([{ status_code: 20000, result: [{ crawl_progress: "finished", crawl_status: { pages_crawled: 3 }, domain_info: { extended_crawl_status: "no_errors", checks: { sitemap: true } }, page_metrics: { checks: {} } }] }]);
    }
    if (path === "/on_page/pages") {
      return ok([{ status_code: 20000, result: [{ items: [
        { resource_type: "html", url: "https://dfstest.co.uk/", status_code: 200, checks: {}, meta: { title: "Home", description: "Plumbers", htags: { h1: ["Plumbers"] } } },
        { resource_type: "html", url: "https://dfstest.co.uk/boiler-repair", status_code: 200, checks: { no_image_alt: true }, meta: { title: "Boiler repair", description: null, htags: { h1: ["Boiler repair"] } } },
      ] }] }]);
    }
    if (path === "/on_page/links") return ok([{ status_code: 20000, result: [{ items: [] }] }]);
    if (path === "/on_page/non_indexable") return ok([{ status_code: 20000, result: [{ items: [] }] }]);
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

describe.skipIf(!hasDb)("DataForSEO tracking and site audit", () => {
  let clientId = "";

  beforeAll(async () => {
    process.env.DATAFORSEO_LOGIN = "test";
    process.env.DATAFORSEO_PASSWORD = "secret";
    vi.stubGlobal("fetch", fakeDfs());
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    await db.update(s.integrations).set({ config: {} }).where(eq(s.integrations.provider, "dataforseo"));
    const [tier] = await db.select().from(s.tiers).limit(1);
    const [c] = await db
      .insert(s.clients)
      .values({ name: "DFS Test", domain: "dfstest.co.uk", websiteUrl: "https://dfstest.co.uk", tierId: tier!.id, status: "active", gscProperty: "sc-domain:dfstest.co.uk", services: ["Boiler repair"], priorityServices: ["Boiler repair"], primaryLocation: "Exeter", locations: ["Nowhereville"] })
      .returning();
    clientId = c!.id;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete process.env.DATAFORSEO_LOGIN;
    delete process.env.DATAFORSEO_PASSWORD;
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    for (const t of [s.serpSnapshots, s.siteAudits, s.attentionItems, s.auditLog] as const) await db.delete(t).where(eq(t.clientId, clientId));
    await db.delete(s.clients).where(eq(s.clients.id, clientId));
  });

  it("posts tracked searches only for towns Google knows, and says which it doesn't", async () => {
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const { postClientSerp } = await import("@/server/dataforseo-runs");
    const out = await postClientSerp(clientId);
    expect(out.unknownTowns).toEqual(["Nowhereville"]);
    expect(out.posted.map((p) => [p.kind, p.query])).toEqual([["organic", "boiler repair exeter"], ["maps", "boiler repair exeter"]]);
    const [att] = await db.select().from(s.attentionItems).where(eq(s.attentionItems.dedupeKey, `serp_towns:${clientId}`));
    expect(att?.title).toContain("Nowhereville");
  });

  it("waits for queued results, then stores positions and shows them in Local visibility", async () => {
    const { collectClientSerp, postClientSerp } = await import("@/server/dataforseo-runs");
    const { storeSerpResults, getLocalVisibility, latestSerpResults } = await import("@/server/serp");
    const { posted } = await postClientSerp(clientId);
    const first = await collectClientSerp(clientId, posted);
    expect(first.pending).toHaveLength(1); // organic still queued
    expect(first.results).toHaveLength(0);
    const second = await collectClientSerp(clientId, posted);
    expect(second.pending).toHaveLength(0);
    await storeSerpResults(clientId, second.results);
    const [r] = await latestSerpResults(clientId);
    expect(r).toMatchObject({ query: "boiler repair exeter", organicPosition: 13, localPosition: 5, organicUrl: "https://www.dfstest.co.uk/boiler-repair/" });
    const vis = await getLocalVisibility(clientId);
    expect(vis.rows).toEqual([expect.objectContaining({ service: "Boiler repair", location: "Exeter", localPosition: 5, organicPosition: 13, localChange: null })]);
  });

  it("turns a finished crawl into to-do items, with mobile speed", async () => {
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const { collectSiteAudit, latestAuditTodo, startSiteAudit } = await import("@/server/dataforseo-runs");
    const { auditId, started } = await startSiteAudit(clientId);
    expect(started).toBe(true);
    expect((await startSiteAudit(clientId)).started).toBe(false); // one crawl at a time
    expect(await collectSiteAudit(auditId)).toBe("finished");
    const todo = (await latestAuditTodo(clientId))!;
    expect(todo.map((t) => t.checkName).sort()).toEqual(["imageAltTags", "metaDescriptions", "pageSpeed"]);
    const [a] = await db.select().from(s.siteAudits).where(eq(s.siteAudits.id, auditId));
    expect(a).toMatchObject({ status: "finished", pagesCrawled: 3 });
  });
});
