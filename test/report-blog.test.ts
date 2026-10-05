import { describe, expect, it } from "vitest";
import { blogTopicCandidates, draftsDueBy, qualityCheck, slugify } from "@/domain/blog";
import { buildSections, changePhrase, performanceBullets, templateSummary, workBullets, type ReportInput } from "@/domain/report";
import { londonMonthBounds, previousPeriod } from "@/domain/schedule";

const base: ReportInput = {
  periodLabel: "September 2026",
  prevMonthName: "August",
  metrics: { source: "month", window: "September 2026", clicks: 1200, prevClicks: 1000, impressions: 40000, prevImpressions: 42000 },
  work: [
    { title: "Rewrite the title on /boiler-repair", type: "metadata" },
    { title: "Publish blog post: How often should a boiler be serviced?", type: "blog_content" },
  ],
  next: [{ title: "Add an Exmouth area page" }],
};

describe("monthly report facts", () => {
  it("states changes in plain words", () => {
    expect(changePhrase(20, "August")).toBe("up 20% on August");
    expect(changePhrase(-5, "August")).toBe("down 5% on August");
    expect(changePhrase(0, "August")).toBe("level with August");
    expect(changePhrase(null, "August")).toBe("");
  });

  it("puts only verified numbers in How it performed", () => {
    expect(performanceBullets(base)).toEqual([
      "Visitors from Google search: 1,200 (up 20% on August)",
      "Times the site appeared in Google results: 40,000 (down 5% on August)",
    ]);
    expect(performanceBullets({ ...base, metrics: null })).toEqual([]);
    const rolling = performanceBullets({ ...base, metrics: { ...base.metrics!, source: "rolling", window: "2 Sep 2026 to 1 Oct 2026" } });
    expect(rolling[0]).toContain("on the previous 30 days");
    expect(rolling.at(-1)).toContain("2 Sep 2026 to 1 Oct 2026");
  });

  it("never hides a decline in the summary", () => {
    const s = templateSummary({ ...base, metrics: { ...base.metrics!, clicks: 800 } }, "example.co.uk");
    expect(s).toContain("down 20% on August");
    expect(s).toMatch(/drop/);
    expect(templateSummary(base, "example.co.uk")).not.toMatch(/drop/);
  });

  it("writes work in business-owner language and omits empty sections", () => {
    expect(workBullets(base)[1]).toBe("Published a new blog post: How often should a boiler be serviced?");
    const sections = buildSections([], workBullets(base), ["x"]);
    expect(sections.map((s) => s.title)).toEqual(["What we did", "Next month"]);
  });

  it("uses London month boundaries", () => {
    expect(previousPeriod("2026-01")).toBe("2025-12");
    const { start, end } = londonMonthBounds("2026-09"); // BST
    expect(start.toISOString()).toBe("2026-08-31T23:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-30T23:00:00.000Z");
    expect(londonMonthBounds("2026-12").start.toISOString()).toBe("2026-12-01T00:00:00.000Z"); // GMT
  });
});

describe("blog topics", () => {
  const input = {
    services: ["Boiler servicing", "Boiler repair"],
    locations: ["Exeter"],
    clientKeywords: [],
    excluded: ["Plymouth"],
    brandTerms: ["Exeter Heating"],
    existingTitles: ["Boiler repair in Exeter"],
  };
  const kw = (keyword: string, impressions = 100) => ({ keyword, impressions, position: 12, period: "last 30 days" });

  it("keeps evidenced, related, informational queries only", () => {
    const out = blogTopicCandidates({
      ...input,
      keywords: [
        kw("how often should a boiler be serviced", 300),
        kw("boiler service cost exeter", 500),
        kw("boiler repair plymouth"), // excluded location
        kw("exeter heating reviews"), // brand
        kw("how to bake bread"), // unrelated
        kw("why is my boiler losing pressure", 5), // too little demand
        kw("boiler repair in exeter"), // already a page
      ],
    });
    expect(out.map((k) => k.keyword)).toEqual(["boiler service cost exeter", "how often should a boiler be serviced"]);
  });

  it("slugifies", () => {
    expect(slugify("How often should a boiler be serviced?")).toBe("how-often-should-a-boiler-be-serviced");
  });

  it("spreads drafts across the weeks of the month", () => {
    expect([1, 8, 15, 22, 29].map((d) => draftsDueBy(4, d, 31))).toEqual([1, 2, 3, 4, 4]);
    expect(draftsDueBy(1, 1, 30)).toBe(1);
    expect(draftsDueBy(0, 20, 30)).toBe(0);
  });
});

describe("blog quality check", () => {
  const paragraph =
    "Regular servicing keeps a boiler running safely and efficiently through the colder months. An engineer checks the burner, the flue, the seals and the pressure, and cleans the parts that build up deposits over time. ";
  const body = `## Why servicing matters\n\n${paragraph.repeat(18)}\n\n## When to book\n\nBook a visit before winter starts.`;
  const draft = { title: "How often should a boiler be serviced?", slug: "how-often-boiler-service", body, metaDescription: "What a boiler service involves and how often to book one.", targetKeyword: "boiler serviced" };
  const ctx = { existingPaths: ["/blog/winter-tips"], existingTitles: ["Winter tips"], excluded: ["Plymouth"], allowedNumbers: [] };

  it("passes a clean draft", () => {
    expect(qualityCheck(draft, ctx)).toEqual([]);
  });

  it("rejects thin, duplicate and unverifiable drafts", () => {
    expect(qualityCheck({ ...draft, body: "Too short." }, ctx)[0]).toMatch(/Too thin/);
    expect(qualityCheck({ ...draft, slug: "winter-tips" }, ctx)).toContain("Duplicates an existing page (same URL)");
    expect(qualityCheck({ ...draft, body: `${body}\n\nWe are an award-winning, Gas Safe registered team.` }, ctx)).toContain("Contains an unverifiable credential or claim");
    expect(qualityCheck({ ...draft, body: `${body}\n\n“They were brilliant and arrived on time” — Sarah` }, ctx)).toContain("Contains a testimonial or review");
    expect(qualityCheck({ ...draft, body: `${body}\n\nA service costs £85 and 93% of boilers fail without one.` }, ctx).join()).toMatch(/Unverifiable figures: £85, 93%/);
    expect(qualityCheck({ ...draft, body: `${body}\n\nWe also cover Plymouth.` }, ctx)).toContain("Mentions excluded “Plymouth”");
    const stuffed = `${body} ${"boiler serviced ".repeat(40)}`;
    expect(qualityCheck({ ...draft, body: stuffed }, ctx).join()).toMatch(/Keyword stuffing/);
  });
});
