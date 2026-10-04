import { describe, expect, it } from "vitest";
import { matchSite, toMonthMetrics, toRollingMetrics } from "@/integrations/siteguru/map";
import { listSitesSchema, topKeywordsSchema, trafficOverviewSchema } from "@/integrations/siteguru/schemas";
import { KEYWORDS_30D, OVERVIEW_30D, SITES } from "./helpers/mock-mcp";

const sites = listSitesSchema.parse(SITES).sites;

describe("SiteGuru mapping", () => {
  it("matches sites by exact domain, ignoring scheme and www", () => {
    expect(matchSite(sites, "projuice.co.uk")?.domain).toBe("https://www.projuice.co.uk");
    expect(matchSite(sites, "https://projuice.co.uk/")?.domain).toBe("https://www.projuice.co.uk");
    expect(matchSite(sites, "juice.co.uk")).toBeNull();
  });

  it("maps the 30-day overview and keywords without inventing anything", () => {
    const m = toRollingMetrics(trafficOverviewSchema.parse(OVERVIEW_30D), topKeywordsSchema.parse(KEYWORDS_30D));
    expect(m.clicks).toBe(2816);
    expect(m.prev?.clicks).toBe(2997);
    expect(m.ctr).toBe(0.9);
    expect(m.avgPosition).toBeNull(); // SiteGuru has no site-wide average position
    expect(m.topPages?.[0]).toEqual({ path: "/", clicks: 603 });
    expect(m.topKeywords).toEqual([
      { keyword: "projuice", position: 1, change: 0 },
      { keyword: "frozen fruit", position: 6, change: 1 }, // moved up from 7.3 to 6.1
      { keyword: "frozen mango chunks", position: 6, change: null }, // wasn't ranking before
    ]);
  });

  it("leaves Search Console figures empty when GSC isn't connected", () => {
    const m = toRollingMetrics(trafficOverviewSchema.parse({ status: "ok", search_console: { status: "not_connected" }, top_pages: [] }), null);
    expect(m.clicks).toBeNull();
    expect(m.impressions).toBeNull();
    expect(m.topPages).toEqual([]);
  });

  it("only produces month snapshots when SiteGuru has the month", () => {
    expect(toMonthMetrics(trafficOverviewSchema.parse({ status: "empty" }))).toBeNull();
    expect(toMonthMetrics(trafficOverviewSchema.parse({ status: "ok", search_console: { status: "ok", clicks: { value: 10 } } }))).toEqual({ clicks: 10, impressions: null });
  });
});
