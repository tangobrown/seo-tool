import { describe, expect, it } from "vitest";
import { DEFAULT_SCORING } from "@/domain/opportunities/config";
import { detect } from "@/domain/opportunities/detect";
import { forceManualIfUnsafe, violatesStrategy } from "@/domain/opportunities/guards";
import { reconcile, type ExistingOpportunity } from "@/domain/opportunities/reconcile";
import { priorityScore, scoreCandidates } from "@/domain/opportunities/score";
import { selectRecommendations, type PoolItem } from "@/domain/opportunities/select";
import { onlyKnownNumbers } from "@/domain/opportunities/text";
import type { DetectionInput, ScoredCandidate } from "@/domain/opportunities/types";
import { isoWeek, isScanDue, londonParts } from "@/domain/schedule";

const cfg = DEFAULT_SCORING;

// Trimmed from real SiteGuru responses for projuice.co.uk (4 Oct 2026).
const input: DetectionInput = {
  client: {
    id: "00000000-0000-0000-0000-000000000001",
    domain: "projuice.co.uk",
    services: ["Frozen fruit", "Smoothies", "Commercial blenders"],
    priorityServices: ["Frozen fruit"],
    locations: ["Exeter", "Devon"],
    excludedServices: ["Ice cream"],
    excludedLocations: [],
    keywords: ["frozen fruit"],
  },
  pages: [],
  signals: {
    todo: [
      { checkName: "siteMap", severity: "high", title: "Optimize your sitemap", description: "We did not find a sitemap on this site. That may cause slower and incomplete indexation.", affectedPages: 2 },
      { checkName: "brokenLinks", severity: "high", title: "Fix broken links", description: "1 broken link on 1 page.", affectedPages: 1 },
      { checkName: "similarContent", severity: "medium", title: "Review similar content", description: "We found 238 pages with similar content.", affectedPages: 238 },
      { checkName: "noindexNofollow", severity: "medium", title: "Make pages indexable", description: "2 pages have incorrect or confusing indexation settings.", affectedPages: 2 },
      { checkName: "imageAltTags", severity: "medium", title: "Add alt texts to your images", description: "50 pages have images without alt texts.", affectedPages: 50 },
    ],
    lowHangingFruit: [
      { keyword: "frozen acai", path: "/product/acai-puree", clicks: 23, impressions: 6867, avgPosition: 4.2 },
      { keyword: "blueberries benefits", path: "/blog/the-top-10-health-benefits-of-blueberries", clicks: 6, impressions: 5802, avgPosition: 8.3 },
      { keyword: "benefits of blueberries", path: "/blog/the-top-10-health-benefits-of-blueberries", clicks: 2, impressions: 3622, avgPosition: 8.2 },
      { keyword: "tiny", path: "/x", clicks: 0, impressions: 50, avgPosition: 6 },
      { keyword: "ice cream cones", path: "/product/ice-cream-sugar-cones", clicks: 7, impressions: 2947, avgPosition: 11 },
    ],
    declining: [
      { path: "/product-category/smoothies/", percentChange: -43.8, netChange: -63, oldestClicks: 144, newestClicks: 81, fromMonth: "2026-03", toMonth: "2026-08" },
      { path: "/product/grapes-10kg/", percentChange: -79.2, netChange: -19, oldestClicks: 24, newestClicks: 5, fromMonth: "2026-03", toMonth: "2026-08" },
    ],
    cannibalization: [
      { keyword: "projuice smoothies", impressions: 292, avgPosition: 1.8, pages: [{ path: "/product-category/smoothies/", clicks: 45, avgPosition: 1.3 }, { path: "/", clicks: 40, avgPosition: 1.9 }] },
    ],
    topPages: [{ path: "/blog/a-british-guide-to-seasonal-fruits-and-vegetables/", clicks: 65, impressions: 34117, avgPosition: 6 }],
  },
};

describe("detection", () => {
  const { candidates, evaluated } = detect(input);
  const keys = candidates.map((c) => `${c.type}:${c.actionKey}:${c.targetUrl ?? ""}`);

  it("maps actionable SiteGuru to-dos and skips vague ones", () => {
    expect(keys).toContain("technical_issue:sitemap:/sitemap.xml");
    expect(keys).toContain("technical_issue:broken_links:");
    expect(keys.some((k) => k.includes("similar"))).toBe(false);
    expect(candidates.find((c) => c.actionKey === "sitemap")!.severity).toBe("critical");
    // Indexation changes are never automatic.
    expect(candidates.find((c) => c.actionKey === "indexability")!.executionType).toBe("manual_action");
  });

  it("groups near-miss keywords per page and ignores tiny volumes", () => {
    const rank = candidates.filter((c) => c.type === "ranking_opportunity");
    expect(rank.map((c) => c.targetUrl).sort()).toEqual(["/blog/the-top-10-health-benefits-of-blueberries", "/product/acai-puree", "/product/ice-cream-sugar-cones"]);
    const blue = rank.find((c) => c.targetUrl!.includes("blueberries"))!;
    expect(blue.targetQuery).toBe("blueberries benefits");
    expect(blue.evidence).toHaveLength(2);
  });

  it("flags meaningful content decay only", () => {
    const d = candidates.filter((c) => c.actionKey === "refresh");
    expect(d.map((c) => c.targetUrl)).toEqual(["/product-category/smoothies/"]); // grapes: too few clicks to matter
    expect(d[0]!.description).toContain("144 in March to 81 in August");
  });

  it("ignores cannibalisation where both pages already rank at the top", () => {
    expect(candidates.some((c) => c.actionKey === "cannibalisation")).toBe(false);
  });

  it("finds weak click-through at a good position", () => {
    expect(candidates.some((c) => c.type === "ctr_improvement")).toBe(true);
  });

  it("every candidate carries evidence", () => {
    expect(candidates.every((c) => c.evidence.length > 0)).toBe(true);
    expect(evaluated.has("pages")).toBe(false); // no inventory → page rules didn't run
  });

  it("suggests missing service pages only from a crawled inventory", () => {
    const withPages = detect({ ...input, pages: [{ path: "/", pageType: "homepage", service: null, location: null, title: "Home", h1: null, internalLinksIn: 0 }] });
    expect(withPages.candidates.some((c) => c.type === "new_service_page" && c.service === "Frozen fruit")).toBe(true);
    // Locations need proven search demand: none of the keywords mention Exeter, so no location page.
    expect(withPages.candidates.some((c) => c.type === "new_location_page")).toBe(false);
  });
});

describe("scoring", () => {
  it("is deterministic and ordered sensibly", () => {
    const scored = scoreCandidates(detect(input).candidates, input.client, cfg);
    const by = (k: string) => scored.find((c) => c.actionKey === k || c.targetQuery === k)!;
    expect(by("frozen acai").priorityScore).toBeGreaterThan(by("blueberries benefits").priorityScore); // commercial page beats blog
    expect(scored.every((c) => c.priorityScore >= 0 && c.priorityScore <= 100)).toBe(true);
    expect(scoreCandidates(detect(input).candidates, input.client, cfg)).toEqual(scored);
  });

  it("boosts priority services and client keywords", () => {
    const base = { impact: 6, commercialValue: 6, confidence: 6, effort: 3, risk: 2 } as Parameters<typeof priorityScore>[0];
    expect(priorityScore(base, 1.5, cfg)).toBeGreaterThan(priorityScore(base, 1, cfg));
  });
});

describe("guards and safety", () => {
  it("drops excluded services", () => {
    expect(violatesStrategy({ type: "ranking_opportunity", title: "x", targetQuery: "ice cream cones", targetUrl: "/p", service: null, location: null }, input.client)).toMatch(/Ice cream/);
  });
  it("forces redirects and deletions to manual", () => {
    expect(forceManualIfUnsafe({ proposedAction: "Add a redirect from /old to /new.", executionType: "github_pr", riskLabel: "low" }).executionType).toBe("manual_action");
    expect(forceManualIfUnsafe({ proposedAction: "Adjust titles. No pages are removed or redirected.", executionType: "github_pr", riskLabel: "low" }).executionType).toBe("github_pr");
  });
});

function scored(fp: string, score: number, extra: Partial<ScoredCandidate> = {}): ScoredCandidate {
  return { ...detect(input).candidates[0]!, fingerprint: fp, evidenceHash: "h1", priorityScore: score, impactLabel: "medium", severity: "normal", ...extra };
}
function existing(fp: string, status: string, extra: Partial<ExistingOpportunity> = {}): ExistingOpportunity {
  return { id: fp, fingerprint: fp, type: "technical_issue", status, evidenceHash: "h1", priorityScore: 70, scoreAtDecision: 70, decidedAt: null, deferredUntil: null, missedScans: 0, family: "todo", ...extra };
}
const now = new Date("2026-10-04T06:00:00Z");
const run = (ex: ExistingOpportunity[], cands: ScoredCandidate[]) =>
  reconcile({ existing: ex, candidates: cands, evaluated: new Set(["todo"]), candidateFamily: () => "todo", now, cfg });

describe("reconcile (dedupe and suppression)", () => {
  it("updates a matching fingerprint instead of inserting", () => {
    const p = run([existing("a", "recommended")], [scored("a", 72)]);
    expect(p.inserts).toHaveLength(0);
    expect(p.refreshes[0]).toMatchObject({ id: "a", evidenceChanged: false });
  });
  it("keeps declined items suppressed for 90 days", () => {
    const declined = existing("a", "declined", { decidedAt: new Date("2026-09-01T00:00:00Z") });
    expect(run([declined], [scored("a", 80, { evidenceHash: "h2" })]).refreshes[0]!.status).toBeUndefined(); // +10 isn't enough
    expect(run([declined], [scored("a", 86, { evidenceHash: "h2" })]).refreshes[0]!.status).toBe("candidate"); // +16 with new evidence
    expect(run([declined], [scored("a", 99, { evidenceHash: "h1" })]).refreshes[0]!.status).toBeUndefined(); // same evidence
    expect(run([declined], [scored("a", 70, { severity: "critical" })]).refreshes[0]!.status).toBe("candidate");
    expect(run([existing("a", "declined", { decidedAt: new Date("2026-06-01T00:00:00Z") })], [scored("a", 70)]).refreshes[0]!.status).toBe("candidate");
  });
  it("resurfaces deferred items only after their date", () => {
    expect(run([existing("a", "deferred", { deferredUntil: new Date("2026-10-10T00:00:00Z") })], [scored("a", 70)]).refreshes[0]!.status).toBeUndefined();
    expect(run([existing("a", "deferred", { deferredUntil: new Date("2026-10-01T00:00:00Z") })], [scored("a", 70)]).refreshes[0]!.status).toBe("candidate");
  });
  it("never recreates completed or in-flight work", () => {
    const p = run([existing("a", "completed"), existing("b", "approved")], [scored("a", 90), scored("b", 90)]);
    expect(p.inserts).toHaveLength(0);
    expect(p.refreshes).toHaveLength(0);
  });
  it("marks items stale after 2 missed scans, only for families that ran", () => {
    expect(run([existing("a", "recommended")], []).missed[0]).toEqual({ id: "a", missedScans: 1, status: undefined });
    expect(run([existing("a", "recommended", { missedScans: 1 })], []).missed[0]!.status).toBe("stale");
    expect(run([existing("a", "recommended", { family: "declining" })], []).missed).toHaveLength(0);
  });
});

describe("selection", () => {
  const item = (id: string, score: number, extra: Partial<PoolItem> = {}): PoolItem => ({
    id, type: "technical_issue", status: "candidate", priorityScore: score, severity: "normal", guardViolation: null, isBlogCommitment: false, ...extra,
  });
  const sel = (pool: PoolItem[], recs = 3, used = 0) => selectRecommendations({ pool, cfg, recsPerScan: recs, minScore: 65, newPagesUsedThisMonth: used });

  it("never pads with items below the minimum score", () => {
    const s = sel([item("a", 90), item("b", 50), item("c", 64)]);
    expect(s.recommended).toEqual(["a"]);
    expect(s.reserve).toEqual([]);
  });
  it("puts critical issues first even below the minimum", () => {
    expect(sel([item("a", 95), item("c", 40, { severity: "critical" })]).recommended[0]).toBe("c");
  });
  it("leaves the overflow in reserve and respects guards", () => {
    const s = sel([item("a", 90), item("b", 85), item("c", 80), item("d", 75), item("x", 99, { guardViolation: "Excluded" })]);
    expect(s.recommended).toHaveLength(3);
    expect(s.reserve).toEqual(["d"]);
    expect(s.recommended).not.toContain("x");
  });
  it("weights shape the mix without forcing low-value work in", () => {
    const pool = [item("t1", 80), item("t2", 80), item("r1", 79, { type: "ranking_opportunity" })];
    expect(sel(pool, 2).recommended.sort()).toEqual(["r1", "t1"]); // diversity beats a 1-point gap
  });
  it("caps new pages per month", () => {
    const s = sel([item("p1", 90, { type: "new_service_page" }), item("p2", 89, { type: "new_service_page" })], 3, 5);
    expect(s.recommended).toEqual(["p1"]);
  });
});

describe("LLM number guard", () => {
  it("rejects numbers that aren't in the evidence", () => {
    expect(onlyKnownNumbers(["Ranks #4.2 with 6,867 impressions"], ["Ranks #4.2 for x with 6,867 impressions"])).toBe(true);
    expect(onlyKnownNumbers(["Could double clicks to 500"], ["Ranks #4.2 with 6,867 impressions"])).toBe(false);
  });
});

describe("scan cadence", () => {
  it("handles weekly, fortnightly and monthly", () => {
    const mon = new Date(Date.UTC(2026, 9, 5)); // Mon 5 Oct 2026
    const created = new Date(Date.UTC(2026, 0, 5)); // ISO week 2
    expect(isScanDue("weekly", mon, created)).toBe(true);
    expect(isScanDue("fortnightly", mon, created)).toBe(isoWeek(mon) % 2 === 0);
    expect(isScanDue("fortnightly", new Date(Date.UTC(2026, 9, 12)), created)).toBe(isoWeek(mon) % 2 !== 0);
    expect(isScanDue("monthly", mon, created)).toBe(true);
    expect(isScanDue("monthly", new Date(Date.UTC(2026, 9, 12)), created)).toBe(false);
  });
  it("reads London wall-clock time across BST", () => {
    expect(londonParts(new Date("2026-10-05T05:30:00Z"))).toMatchObject({ isoDay: 1, hhmm: "06:30" });
    expect(londonParts(new Date("2026-12-07T06:00:00Z"))).toMatchObject({ isoDay: 1, hhmm: "06:00" });
  });
});
