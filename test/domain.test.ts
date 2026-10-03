import { describe, expect, it } from "vitest";
import { isBlogBehind } from "@/domain/blog";
import { evidenceHash, normaliseQuery, normaliseUrl, opportunityFingerprint } from "@/domain/fingerprint";
import { canonicalPageUrl, extractPage, extractSitemapLocs, guessPageType, isInternalPage } from "@/domain/html";
import { firstName, reportEmailHtml, reportEmailText, reportSubject } from "@/domain/report-email";

describe("fingerprint", () => {
  it("normalises URLs and queries so equivalent targets match", () => {
    expect(normaliseUrl("https://www.Example.co.uk/Boiler-Repair/?utm=x#top")).toBe("/boiler-repair");
    expect(normaliseUrl("example.co.uk")).toBe("/");
    expect(normaliseQuery("  Boiler   Repair EXETER ")).toBe("boiler repair exeter");
    const a = opportunityFingerprint({ clientId: "c", type: "metadata", targetUrl: "https://x.co.uk/a/", targetQuery: "Q", actionKey: "k" });
    const b = opportunityFingerprint({ clientId: "c", type: "metadata", targetUrl: "/a", targetQuery: "q", actionKey: "k" });
    expect(a).toBe(b);
    expect(opportunityFingerprint({ clientId: "c", type: "metadata", targetUrl: "/a", actionKey: "other" })).not.toBe(a);
  });
  it("hashes evidence deterministically", () => {
    expect(evidenceHash([{ a: 1 }])).toBe(evidenceHash([{ a: 1 }]));
    expect(evidenceHash([{ a: 1 }])).not.toBe(evidenceHash([{ a: 2 }]));
  });
});

describe("html extraction", () => {
  const html = `<html><head><title>Boiler Repair Exeter | Exeter Heating</title>
    <link rel="canonical" href="https://exeterheating.co.uk/boiler-repair">
    <meta name="robots" content="index, follow"></head>
    <body><nav><a href="/about">About</a></nav><h1>Boiler <em>repair</em> in Exeter</h1>
    <p>Same-day boiler repair &amp; servicing.</p><a href="/contact">Contact</a><a href="mailto:x@y.z">Mail</a>
    <a href="https://other.com/">Ext</a><script>var x = 1;</script></body></html>`;
  it("pulls title, h1, canonical, links and text", () => {
    const p = extractPage(html, "https://exeterheating.co.uk/boiler-repair");
    expect(p.title).toBe("Boiler Repair Exeter | Exeter Heating");
    expect(p.h1).toBe("Boiler repair in Exeter");
    expect(p.canonical).toBe("https://exeterheating.co.uk/boiler-repair");
    expect(p.noindex).toBe(false);
    expect(p.links).toContain("https://exeterheating.co.uk/contact");
    expect(p.links.some((l) => l.startsWith("mailto"))).toBe(false);
    expect(p.text).toContain("Same-day boiler repair & servicing.");
    expect(p.text).not.toContain("var x");
  });
  it("detects noindex", () => {
    expect(extractPage('<meta name="robots" content="noindex,follow">', "https://a.co.uk/").noindex).toBe(true);
  });
  it("reads sitemaps and sitemap indexes", () => {
    expect(extractSitemapLocs("<urlset><url><loc>https://a.co.uk/x</loc></url></urlset>").pages).toEqual(["https://a.co.uk/x"]);
    expect(extractSitemapLocs("<sitemapindex><sitemap><loc>https://a.co.uk/s1.xml</loc></sitemap></sitemapindex>").sitemaps).toEqual(["https://a.co.uk/s1.xml"]);
  });
  it("filters internal pages", () => {
    expect(isInternalPage("https://www.a.co.uk/x", "a.co.uk")).toBe(true);
    expect(isInternalPage("https://a.co.uk/logo.png", "a.co.uk")).toBe(false);
    expect(isInternalPage("https://b.co.uk/x", "a.co.uk")).toBe(false);
    expect(canonicalPageUrl("https://a.co.uk/x/?q=1#h")).toBe("https://a.co.uk/x");
    expect(guessPageType("/blog/post")).toBe("blog");
    expect(guessPageType("/")).toBe("homepage");
  });
});

describe("blog commitment", () => {
  it("is behind only in the final 7 days with fewer than N approved", () => {
    expect(isBlogBehind({ committed: 4, approved: 2, now: new Date(), daysInMonth: 31, dayOfMonth: 20 })).toBe(false);
    expect(isBlogBehind({ committed: 4, approved: 2, now: new Date(), daysInMonth: 31, dayOfMonth: 25 })).toBe(true);
    expect(isBlogBehind({ committed: 4, approved: 4, now: new Date(), daysInMonth: 31, dayOfMonth: 30 })).toBe(false);
  });
});

describe("report email", () => {
  const r = {
    contactName: "Dr. Maya Chen",
    periodLabel: "September 2026",
    summary: "Clicks <rose>.",
    sections: [{ title: "What we did", items: ["Fixed links"] }],
    signoff: "Thanks,\nThe team",
  };
  it("builds plain text in the mock's format", () => {
    expect(firstName("Dr. Maya Chen")).toBe("Maya");
    expect(reportEmailText(r)).toBe("Hi Maya,\n\nHere’s your SEO summary for September 2026.\n\nClicks <rose>.\n\nWhat we did\n• Fixed links\n\nThanks,\nThe team");
  });
  it("escapes HTML and builds the subject", () => {
    expect(reportEmailHtml(r)).toContain("Clicks &lt;rose&gt;.");
    expect(reportEmailHtml(r)).toContain("<li>Fixed links</li>");
    expect(reportSubject("September 2026", "Okafor Legal")).toBe("September SEO update — Okafor Legal");
  });
});
