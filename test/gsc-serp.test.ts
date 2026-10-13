import { describe, expect, it } from "vitest";
import { cannibalizationFrom, decliningFrom, lowHangingFruitFrom, monthlyTotals, pathOf, topPagesFrom, totalsToMetrics, type GscRow } from "@/domain/gsc-signals";
import { detect } from "@/domain/opportunities/detect";
import { competitors, isClientDomain, trackedQueries, type SerpResult } from "@/domain/serp";

const row = (keys: string[], clicks: number, impressions: number, position: number): GscRow => ({ keys, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });

describe("Search Console signals", () => {
  it("normalises page URLs to paths", () => {
    expect(pathOf("https://www.example.co.uk/boiler-repair/?utm=x#top")).toBe("/boiler-repair");
    expect(pathOf("https://example.co.uk/")).toBe("/");
  });

  it("turns totals into KPI metrics with CTR as a percentage", () => {
    const m = totalsToMetrics(row([], 120, 4000, 12.345), row([], 100, 5000, 14));
    expect(m).toEqual({ clicks: 120, impressions: 4000, ctr: 3, avgPosition: 12.3, prev: { clicks: 100, impressions: 5000, ctr: 2, avgPosition: 14 } });
  });

  it("merges URL variants in top pages", () => {
    const out = topPagesFrom([row(["https://x.co.uk/a"], 10, 100, 4), row(["https://x.co.uk/a/"], 5, 100, 6), row(["https://x.co.uk/b"], 12, 50, 2)]);
    expect(out[0]).toEqual({ path: "/a", clicks: 15, impressions: 200, avgPosition: 5 });
  });

  it("finds near misses and competing pages", () => {
    const rows = [
      row(["boiler repair exeter", "https://x.co.uk/boiler-repair"], 10, 900, 7.2),
      row(["boiler repair exeter", "https://x.co.uk/"], 3, 300, 11),
      row(["boiler repair exeter", "https://x.co.uk/blog/old"], 0, 15, 40),
      row(["gas safe exeter", "https://x.co.uk/"], 50, 400, 2),
    ];
    expect(lowHangingFruitFrom(rows).map((k) => [k.keyword, k.path])).toEqual([
      ["boiler repair exeter", "/boiler-repair"],
      ["boiler repair exeter", "/"],
    ]);
    const c = cannibalizationFrom(rows);
    expect(c).toHaveLength(1);
    expect(c[0]!.pages.map((p) => p.path)).toEqual(["/boiler-repair", "/"]); // the 15-impression page is noise
  });

  it("finds pages losing clicks between the oldest and newest month", () => {
    const out = decliningFrom([
      { month: "2026-04", rows: [row(["https://x.co.uk/a"], 100, 1000, 5), row(["https://x.co.uk/b"], 10, 100, 5)] },
      { month: "2026-09", rows: [row(["https://x.co.uk/a"], 60, 900, 7), row(["https://x.co.uk/b"], 20, 100, 5)] },
    ]);
    expect(out).toEqual([{ path: "/a", oldestClicks: 100, newestClicks: 60, netChange: -40, percentChange: -40, fromMonth: "2026-04", toMonth: "2026-09" }]);
  });

  it("only counts calendar months the data fully covers", () => {
    const days = ["2026-07-15", "2026-07-31", "2026-08-01", "2026-08-31", "2026-09-01", "2026-09-28"].map((d) => row([d], 10, 100, 5));
    expect(monthlyTotals(days).map((m) => [m.month, m.complete])).toEqual([
      ["2026-07", false], // window started mid-month
      ["2026-08", true],
      ["2026-09", false], // Google hasn't reported the last days yet
    ]);
  });
});

describe("local search tracking", () => {
  const client = { services: ["Boiler repair", "Boiler servicing", "Plumbing"], priorityServices: ["Boiler repair", "Boiler servicing"], locations: ["Exmouth", "Plymouth", "Topsham"], primaryLocation: "Exeter", excludedServices: [], excludedLocations: ["Plymouth"] };

  it("tracks priority services × towns, primary town first, never excluded ones, within the cap", () => {
    expect(trackedQueries(client, 30).map((q) => q.query)).toEqual([
      "boiler repair exeter", "boiler servicing exeter", "boiler repair exmouth", "boiler servicing exmouth", "boiler repair topsham", "boiler servicing topsham",
    ]);
    expect(trackedQueries(client, 3)).toHaveLength(3);
  });

  const serp = (query: string, organicPosition: number | null, localPosition: number | null, organic: string[]): SerpResult => ({
    query, service: "Boiler repair", location: query.split(" ").at(-1)!.replace(/^./, (c) => c.toUpperCase()), organicPosition, localPosition,
    organicUrl: organicPosition ? "https://www.client.co.uk/boiler-repair/" : null,
    organic: organic.map((domain, i) => ({ position: i + 1, domain, url: `https://${domain}/`, title: domain })),
    local: [{ position: 1, title: "Rival Heating", domain: "rival.co.uk", rating: 4.8 }, { position: 2, title: "Other Ltd", domain: null, rating: null }, { position: 3, title: "Third Co", domain: "third.co.uk", rating: 4.1 }],
  });

  it("recognises the client's own domain and finds recurring competitors (not directories)", () => {
    expect(isClientDomain("www.client.co.uk", "client.co.uk")).toBe(true);
    expect(isClientDomain("notclient.co.uk", "client.co.uk")).toBe(false);
    const results = [
      serp("boiler repair exeter", 14, null, ["rival.co.uk", "www.yell.com", "third.co.uk"]),
      serp("boiler repair exmouth", 4, 2, ["rival.co.uk", "client.co.uk", "checkatrade.com"]),
    ];
    expect(competitors(results, "client.co.uk")).toEqual([{ domain: "rival.co.uk", appearances: 2, bestPosition: 1 }]);
  });

  it("recommends map-pack and page-two work with search evidence", () => {
    const { candidates, evaluated } = detect({
      client: { id: "c", domain: "client.co.uk", services: ["Boiler repair"], priorityServices: ["Boiler repair"], locations: ["Exeter", "Exmouth"], excludedServices: [], excludedLocations: [], keywords: [] },
      pages: [],
      signals: { serp: [serp("boiler repair exeter", 14, null, ["rival.co.uk"]), serp("boiler repair exmouth", 3, 2, ["rival.co.uk"])] },
    });
    expect(evaluated.has("serp")).toBe(true);
    const map = candidates.find((c) => c.type === "local_visibility")!;
    expect(map.title).toBe("Get into Google’s map results for boiler repair in Exeter");
    expect(map.executionType).toBe("manual_action");
    expect(map.evidence[0]).toMatchObject({ source: "serp", value: "not in top results" });
    const rank = candidates.find((c) => c.actionKey === "serp_rank:boiler-repair-exeter")!;
    expect(rank.targetUrl).toBe("/boiler-repair");
    expect(rank.evidence[0]).toMatchObject({ source: "serp", value: "#14" });
    expect(candidates.some((c) => c.actionKey === "serp_rank:boiler-repair-exmouth")).toBe(false); // already on page one
  });
});

describe("site audit → to-do items", async () => {
  const { auditToTodo } = await import("@/domain/audit");
  const page = (path: string, meta: { title?: string; description?: string; h1?: string[] }, checks: Record<string, boolean> = {}, status = 200) => ({
    url: `https://www.x.co.uk${path}`,
    status_code: status,
    checks,
    meta: { title: meta.title ?? null, description: meta.description ?? null, htags: (meta.h1 ? { h1: meta.h1 } : {}) as Record<string, string[]> },
  });

  it("works out problems from the crawled pages and maps them to the existing rules", () => {
    const todo = auditToTodo({
      pages: [
        page("/", { title: "Home", description: "Welcome", h1: ["Plumbers"] }),
        page("/a", { title: "Same", description: "", h1: ["A"] }, { no_image_alt: true }),
        page("/b", { title: "Same", description: "B page", h1: [] }, { is_orphan_page: true }),
        page("/gone", {}, {}, 404),
      ],
      brokenLinks: [{ page_from: "/a", link_to: "https://www.x.co.uk/old" }],
      linksToRedirects: [],
      nonIndexable: [{ reason: "meta_tag", url: "https://www.x.co.uk/private" }],
      domainChecks: { sitemap: false },
      speed: [{ url: "https://www.x.co.uk/", score: 31, lcpMs: 5200 }, { url: "https://www.x.co.uk/a", score: 88, lcpMs: 1500 }],
    })!;
    const by = Object.fromEntries(todo.map((t) => [t.checkName, t]));
    expect(by.siteMap?.description).toMatch(/did not find a sitemap/); // critical rule trigger
    expect(by.pageTitles?.affectedPages).toBe(2); // the duplicate pair; the 404 is ignored
    expect(by.metaDescriptions?.affectedPages).toBe(1);
    expect(by.headings?.description).toContain("/b");
    expect(by.imageAltTags?.affectedPages).toBe(1);
    expect(by.orphanPages?.affectedPages).toBe(1);
    expect(by.brokenLinks?.description).toContain("/old");
    expect(by.noindexNofollow?.description).toContain("meta tag");
    expect(by.pageSpeed?.description).toContain("/ 31/100");
    expect(by.internalRedirects).toBeUndefined();
  });

  it("feeds the detection rules with the site-audit source", () => {
    const todo = auditToTodo({ pages: [page("/", { title: "", description: "d", h1: ["h"] })], brokenLinks: [], linksToRedirects: [], nonIndexable: [], domainChecks: {}, speed: [] })!;
    const { candidates } = detect({
      client: { id: "c", domain: "x.co.uk", services: [], priorityServices: [], locations: [], excludedServices: [], excludedLocations: [], keywords: [] },
      pages: [],
      signals: { todo, sources: { audit: "dataforseo" } },
    });
    expect(candidates[0]).toMatchObject({ actionKey: "titles", type: "metadata" });
    expect(candidates[0]!.evidence[0]!.source).toBe("dataforseo");
  });
});
