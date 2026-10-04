import type { EvidenceItem } from "@/db/schema";
import type { Candidate, DetectionInput, SignalFamily } from "./types";

// Deterministic detection rules (§10.2). Each rule emits candidates with structured evidence and
// factual template text. The LLM may later reword the text; it never decides what is detected.

const nf = new Intl.NumberFormat("en-GB");
const n = (x: number) => nf.format(Math.round(x));
const pct = (x: number) => `${Math.round(Math.abs(x))}%`;

function monthName(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, 1)));
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${n(count)} ${count === 1 ? one : many}`;
}

function isCommercial(path: string, pages: DetectionInput["pages"]): boolean {
  const p = pages.find((x) => x.path === path || x.path === path.replace(/\/$/, ""));
  // Product and category pages are usually classified "other", so only these are non-commercial.
  if (p) return !["blog", "about", "contact"].includes(p.pageType);
  return !/^\/(blog|news|articles|guides)\//i.test(path);
}

// ── SiteGuru to-do list → technical / on-page fixes ─────────────────────────────

type TodoRule = Omit<Candidate, "evidence" | "family" | "severity" | "description" | "title"> & {
  title: (pages: number) => string;
  critical?: (description: string) => boolean;
};

const TODO_RULES: Record<string, TodoRule> = {
  siteMap: {
    type: "technical_issue", category: "technical", actionKey: "sitemap", targetUrl: "/sitemap.xml", targetQuery: null,
    title: () => "Fix the XML sitemap",
    why: "Search engines use the sitemap to find and index pages quickly. Missing or broken sitemaps slow indexation.",
    proposedAction: "Add or fix app/sitemap.ts so it lists every indexable page, using the Next.js Metadata API.",
    expectedBenefit: "Faster, more complete indexation of new and updated pages.",
    impact: 7, commercialValue: 6, confidence: 8, effort: 2, risk: 2, executionType: "github_pr", riskLabel: "low",
    critical: (d) => /did not find a sitemap/i.test(d),
  },
  noindexNofollow: {
    type: "technical_issue", category: "technical", actionKey: "indexability", targetUrl: null, targetQuery: null,
    title: (p) => `Check indexation settings on ${plural(p, "page")}`,
    why: "Pages set to noindex, or with conflicting signals, can't appear in Google. Some may be intentional, so this needs a human check.",
    proposedAction: "Review the listed pages in SiteGuru’s indexation report and confirm which should be indexable. Changing indexation is never automatic.",
    expectedBenefit: "Pages that should rank become eligible to appear in search.",
    impact: 8, commercialValue: 6, confidence: 6, effort: 2, risk: 5, executionType: "manual_action", riskLabel: "medium",
  },
  canonical: {
    type: "technical_issue", category: "technical", actionKey: "canonicals", targetUrl: null, targetQuery: null,
    title: (p) => `Fix canonical URLs on ${plural(p, "page")}`,
    why: "Wrong or missing canonicals can split ranking signals between duplicate URLs.",
    proposedAction: "Set a self-referencing canonical on each affected page via the Metadata API (alternates.canonical).",
    expectedBenefit: "Ranking signals consolidate on the right URL.",
    impact: 7, commercialValue: 6, confidence: 7, effort: 2, risk: 3, executionType: "github_pr", riskLabel: "low",
  },
  brokenLinks: {
    type: "technical_issue", category: "technical", actionKey: "broken_links", targetUrl: null, targetQuery: null,
    title: (p) => `Fix broken internal links on ${plural(p, "page")}`,
    why: "Links to missing pages waste crawl budget and lose visitors.",
    proposedAction: "Point each broken internal link at the correct live page. No redirects are added.",
    expectedBenefit: "Cleaner crawl and fewer dead ends for visitors.",
    impact: 6, commercialValue: 5, confidence: 9, effort: 1, risk: 1, executionType: "github_pr", riskLabel: "low",
  },
  internalRedirects: {
    type: "technical_issue", category: "technical", actionKey: "internal_redirects", targetUrl: null, targetQuery: null,
    title: () => "Update internal links that go through redirects",
    why: "Internal links that hit a redirect slow pages down and dilute link value.",
    proposedAction: "Change internal links to point straight at the final URL. Existing redirects are left alone.",
    expectedBenefit: "Slightly faster pages and cleaner internal linking.",
    impact: 4, commercialValue: 4, confidence: 7, effort: 2, risk: 1, executionType: "github_pr", riskLabel: "low",
  },
  pageSpeed: {
    type: "technical_issue", category: "technical", actionKey: "page_speed", targetUrl: null, targetQuery: null,
    title: (p) => `Speed up ${plural(p, "slow page")}`,
    why: "Slow pages lose visitors and can rank lower, especially on mobile.",
    proposedAction: "Compress and resize large images and serve them with next/image on the slowest pages.",
    expectedBenefit: "Faster mobile load times.",
    impact: 6, commercialValue: 6, confidence: 5, effort: 5, risk: 2, executionType: "github_pr", riskLabel: "low",
    autoApproveKind: "image_compression",
  },
  imageAltTags: {
    type: "technical_issue", category: "technical", actionKey: "alt_text", targetUrl: null, targetQuery: null,
    title: (p) => `Add alt text to images on ${plural(p, "page")}`,
    why: "Alt text helps accessibility and lets images appear in image search.",
    proposedAction: "Add short, descriptive alt text to images that have none. No keyword stuffing.",
    expectedBenefit: "Better accessibility and image search visibility.",
    impact: 4, commercialValue: 3, confidence: 6, effort: 2, risk: 1, executionType: "github_pr", riskLabel: "low",
    autoApproveKind: "alt_text",
  },
  structuredData: {
    type: "schema", category: "technical", actionKey: "schema", targetUrl: null, targetQuery: null,
    title: (p) => `Fix structured data on ${plural(p, "page")}`,
    why: "Valid structured data makes pages eligible for rich results.",
    proposedAction: "Add or correct JSON-LD with the right @type for each affected page.",
    expectedBenefit: "Eligibility for rich results in Google.",
    impact: 5, commercialValue: 5, confidence: 6, effort: 2, risk: 1, executionType: "github_pr", riskLabel: "low",
    autoApproveKind: "schema",
  },
  ogTags: {
    type: "metadata", category: "on_page", actionKey: "og_tags", targetUrl: null, targetQuery: null,
    title: (p) => `Add social sharing tags to ${plural(p, "page")}`,
    why: "Without OpenGraph tags, shared links show a poor preview.",
    proposedAction: "Add openGraph title, description and image via the Metadata API.",
    expectedBenefit: "Better-looking links when pages are shared.",
    impact: 3, commercialValue: 3, confidence: 5, effort: 2, risk: 1, executionType: "github_pr", riskLabel: "low",
  },
  orphanPages: {
    type: "internal_linking", category: "on_page", actionKey: "orphans", targetUrl: null, targetQuery: null,
    title: (p) => `Link to ${plural(p, "page")} nothing links to`,
    why: "Pages with no internal links are hard for search engines to find and rank.",
    proposedAction: "Add contextual links to each orphan page from related pages.",
    expectedBenefit: "Orphan pages get discovered and gain ranking signals.",
    impact: 5, commercialValue: 5, confidence: 6, effort: 3, risk: 1, executionType: "github_pr", riskLabel: "low",
  },
};

function fromTodo(input: DetectionInput): Candidate[] {
  const out: Candidate[] = [];
  for (const t of input.signals.todo ?? []) {
    const rule = TODO_RULES[t.checkName];
    if (!rule) continue; // e.g. similarContent, backlinks: too vague to act on without specifics
    const pages = typeof t.affectedPages === "number" && t.affectedPages > 0 ? t.affectedPages : 1;
    const description = t.description?.trim() || t.title;
    const evidence: EvidenceItem[] = [
      { source: "siteguru", metric: t.title.toLowerCase(), value: typeof t.affectedPages === "number" ? `${n(pages)} pages` : "site-wide", note: description, url: t.reportUrl },
    ];
    const { title, critical, ...rest } = rule;
    out.push({
      ...rest,
      family: "todo",
      title: title(pages),
      description,
      evidence,
      impact: Math.min(10, rule.impact + (t.severity === "high" ? 1 : 0)),
      severity: critical?.(description) ? "critical" : "normal",
    });
  }
  return out;
}

// ── Near-miss rankings → ranking_opportunity ───────────────────────────────────

function fromLowHangingFruit(input: DetectionInput): Candidate[] {
  const byPath = new Map<string, NonNullable<DetectionInput["signals"]["lowHangingFruit"]>>();
  for (const k of input.signals.lowHangingFruit ?? []) {
    if (k.avgPosition < 4 || k.avgPosition > 15 || k.impressions < 300) continue;
    const list = byPath.get(k.path) ?? [];
    list.push(k);
    byPath.set(k.path, list);
  }
  const out: Candidate[] = [];
  for (const [path, kws] of byPath) {
    kws.sort((a, b) => b.impressions - a.impressions);
    const top = kws[0]!;
    const commercial = isCommercial(path, input.pages);
    const impressions = kws.reduce((s, k) => s + k.impressions, 0);
    out.push({
      type: "ranking_opportunity",
      category: "on_page",
      family: "lowHangingFruit",
      actionKey: "rank",
      targetUrl: path,
      targetQuery: top.keyword,
      title: `Push “${top.keyword}” onto page one’s top spots`,
      description: `Ranks #${top.avgPosition.toFixed(1)} for “${top.keyword}” with ${n(top.impressions)} impressions in the last 90 days but only ${n(top.clicks)} clicks.`,
      why: "Pages ranking just below the top few results get most of the impressions but few of the clicks. Small on-page improvements can move them up.",
      proposedAction: `Rework the title, meta description, H1 and opening copy of ${path} around “${top.keyword}”, and add internal links to it using that phrase.`,
      expectedBenefit: "More clicks from searches that already show this page.",
      evidence: kws.slice(0, 3).map((k) => ({
        source: "siteguru" as const,
        metric: "position",
        value: `#${k.avgPosition.toFixed(1)}`,
        period: "last 90 days",
        url: path,
        note: `“${k.keyword}”: ${n(k.impressions)} impressions, ${n(k.clicks)} clicks`,
      })),
      impact: impressions >= 5000 ? 9 : impressions >= 2000 ? 8 : impressions >= 1000 ? 7 : 6,
      commercialValue: commercial ? 7 : 4,
      confidence: top.avgPosition <= 8 ? 7 : 6,
      effort: 3,
      risk: 2,
      executionType: "github_pr",
      riskLabel: "low",
      severity: "normal",
    });
  }
  return out;
}

// ── Content decay → existing_page_optimisation ─────────────────────────────────

function fromDeclining(input: DetectionInput): Candidate[] {
  return (input.signals.declining ?? [])
    .filter((p) => p.percentChange <= -20 && p.oldestClicks >= 30)
    .map((p) => ({
      type: "existing_page_optimisation",
      category: "content" as const,
      family: "declining" as const,
      actionKey: "refresh",
      targetUrl: p.path,
      targetQuery: null,
      title: `Refresh ${p.path === "/" ? "the homepage" : p.path}: clicks down ${pct(p.percentChange)}`,
      description: `Monthly clicks fell from ${n(p.oldestClicks)} in ${monthName(p.fromMonth)} to ${n(p.newestClicks)} in ${monthName(p.toMonth)}.`,
      why: "A steady decline usually means competitors have fresher or more complete content for the same searches.",
      proposedAction: `Update outdated sections of ${p.path}, tighten the title and meta description, and add a short FAQ answering common questions.`,
      expectedBenefit: "Recover lost clicks on an established page.",
      evidence: [
        { source: "siteguru" as const, metric: "monthly clicks", value: `${n(p.oldestClicks)} → ${n(p.newestClicks)}`, period: `${monthName(p.fromMonth)}–${monthName(p.toMonth)}`, url: p.path },
        { source: "siteguru" as const, metric: "change", value: `-${pct(p.percentChange)}`, period: "6 months", url: p.path },
      ],
      impact: Math.abs(p.netChange) >= 100 ? 8 : Math.abs(p.netChange) >= 40 ? 7 : 6,
      commercialValue: isCommercial(p.path, input.pages) ? 7 : 4,
      confidence: 6,
      effort: 4,
      risk: 2,
      executionType: "github_pr" as const,
      riskLabel: "low" as const,
      severity: "normal" as const,
    }));
}

// ── Keyword cannibalisation → existing_page_optimisation ───────────────────────

function fromCannibalization(input: DetectionInput): Candidate[] {
  return (input.signals.cannibalization ?? [])
    // Two pages both ranking at the top for a query isn't a problem worth a recommendation.
    .filter((k) => (k.avgPosition ?? 0) > 3 && k.impressions >= 100 && k.pages.length >= 2)
    .map((k) => ({
      type: "existing_page_optimisation",
      category: "on_page" as const,
      family: "cannibalization" as const,
      actionKey: "cannibalisation",
      targetUrl: k.pages[0]!.path,
      targetQuery: k.keyword,
      title: `Stop ${k.pages.length} pages competing for “${k.keyword}”`,
      description: `${k.pages.map((p) => p.path).join(" and ")} both rank for “${k.keyword}” (average #${(k.avgPosition ?? 0).toFixed(1)}), splitting clicks.`,
      why: "When several pages target the same search, Google often ranks neither well.",
      proposedAction: `Make ${k.pages[0]!.path} the clear page for “${k.keyword}”: adjust the other page’s title and headings to its own topic and link it to ${k.pages[0]!.path}. No pages are removed or redirected.`,
      expectedBenefit: "One stronger page ranking higher for the query.",
      evidence: k.pages.slice(0, 3).map((p) => ({
        source: "siteguru" as const,
        metric: "position",
        value: p.avgPosition != null ? `#${p.avgPosition.toFixed(1)}` : "—",
        period: "last 90 days",
        url: p.path,
        note: `“${k.keyword}”: ${n(p.clicks)} clicks`,
      })),
      impact: 6,
      commercialValue: 6,
      confidence: 5,
      effort: 4,
      risk: 4,
      executionType: "github_pr" as const,
      riskLabel: "medium" as const,
      severity: "normal" as const,
    }));
}

// ── Low CTR at a good position → ctr_improvement ───────────────────────────────

// Conservative typical click-through by position. We only flag pages below 40% of this.
const EXPECTED_CTR: Record<number, number> = { 1: 0.2, 2: 0.12, 3: 0.08, 4: 0.06, 5: 0.045, 6: 0.035, 7: 0.03, 8: 0.025, 9: 0.02, 10: 0.018 };

function fromTopPages(input: DetectionInput): Candidate[] {
  const out: Candidate[] = [];
  for (const p of input.signals.topPages ?? []) {
    const pos = Math.round(p.avgPosition);
    const expected = EXPECTED_CTR[pos];
    if (!expected || p.impressions < 1000) continue;
    const ctr = p.clicks / p.impressions;
    if (ctr >= expected * 0.4) continue;
    out.push({
      type: "ctr_improvement",
      category: "on_page",
      family: "topPages",
      actionKey: "ctr",
      targetUrl: p.path,
      targetQuery: null,
      title: `Improve the search snippet for ${p.path === "/" ? "the homepage" : p.path}`,
      description: `Averages position ${p.avgPosition.toFixed(1)} with ${n(p.impressions)} impressions in the last 30 days, but only ${n(p.clicks)} clicks (${(ctr * 100).toFixed(1)}%).`,
      why: "A page this high in results should earn far more clicks. The title and description are likely not compelling or not matching the search.",
      proposedAction: `Rewrite the title tag and meta description of ${p.path} to match what searchers want and give a clear reason to click.`,
      expectedBenefit: "More clicks without needing a higher ranking.",
      evidence: [
        { source: "siteguru", metric: "click-through rate", value: `${(ctr * 100).toFixed(1)}%`, period: "last 30 days", url: p.path, note: `${n(p.clicks)} clicks from ${n(p.impressions)} impressions` },
        { source: "siteguru", metric: "average position", value: p.avgPosition.toFixed(1), period: "last 30 days", url: p.path },
      ],
      impact: p.impressions >= 5000 ? 8 : 6,
      commercialValue: isCommercial(p.path, input.pages) ? 7 : 4,
      confidence: 6,
      effort: 2,
      risk: 1,
      executionType: "github_pr",
      riskLabel: "low",
      severity: "normal",
    });
  }
  return out;
}

// ── Page inventory → internal linking, missing service/location pages ──────────

function norm(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function slug(s: string) {
  return norm(s).replace(/ /g, "-");
}
function pageCovers(p: DetectionInput["pages"][number], term: string): boolean {
  const t = norm(term);
  return [p.service, p.location, p.title, p.h1, p.path.replace(/[/-]/g, " ")].some((x) => x && norm(x).includes(t));
}

function demandFor(term: string, input: DetectionInput) {
  const t = norm(term);
  const kws = [
    ...(input.signals.keywords ?? []).map((k) => ({ keyword: k.keyword, impressions: k.impressions, period: "last 30 days" })),
    ...(input.signals.lowHangingFruit ?? []).map((k) => ({ keyword: k.keyword, impressions: k.impressions, period: "last 90 days" })),
  ].filter((k) => norm(k.keyword).includes(t));
  const seen = new Set<string>();
  return kws.filter((k) => !seen.has(k.keyword) && seen.add(k.keyword)).sort((a, b) => b.impressions - a.impressions);
}

function fromPages(input: DetectionInput): Candidate[] {
  if (!input.pages.length) return []; // no inventory, nothing we can say about missing pages
  const out: Candidate[] = [];

  for (const p of input.pages) {
    if (!["service", "location", "service_location"].includes(p.pageType) || p.internalLinksIn > 1) continue;
    out.push({
      type: "internal_linking", category: "on_page", family: "pages", actionKey: "links_in", targetUrl: p.path, targetQuery: null,
      title: `Add internal links to ${p.title ?? p.path}`,
      description: `This ${p.pageType.replace("_", " ")} page has ${plural(p.internalLinksIn, "internal link")} pointing to it.`,
      why: "Search engines judge a page’s importance partly by how many of the site’s own pages link to it.",
      proposedAction: `Add contextual links to ${p.path} from related pages (homepage, relevant service and blog pages) using descriptive anchor text.`,
      expectedBenefit: "Stronger ranking signals for a commercial page.",
      evidence: [{ source: "crawl", metric: "internal links in", value: p.internalLinksIn, url: p.path }],
      impact: 6, commercialValue: 7, confidence: 6, effort: 2, risk: 1, executionType: "github_pr", riskLabel: "low", severity: "normal",
      service: p.service, location: p.location,
    });
  }

  for (const service of input.client.priorityServices) {
    if (input.pages.some((p) => (p.pageType === "service" || p.pageType === "service_location") && pageCovers(p, service))) continue;
    const demand = demandFor(service, input);
    out.push({
      type: "new_service_page", category: "content", family: "pages", actionKey: `service:${slug(service)}`,
      targetUrl: `/${slug(service)}`, targetQuery: service.toLowerCase(),
      title: `Create a dedicated ${service} page`,
      description: `${service} is a priority service, but no page on the site is dedicated to it.`,
      why: "A focused service page is usually what ranks for a service search. Without one, the site relies on general pages.",
      proposedAction: `Add a ${service} page covering what’s included, the areas served and how to get in touch, linked from the homepage and navigation. Only facts from the client’s strategy are used.`,
      expectedBenefit: "A page that can rank for searches about this service.",
      evidence: [
        { source: "crawl", metric: "dedicated page", value: "none found", note: `${input.pages.length} pages crawled` },
        ...demand.slice(0, 2).map((k) => ({ source: "siteguru" as const, metric: "impressions", value: n(k.impressions), period: k.period, note: `“${k.keyword}”` })),
      ],
      impact: 8, commercialValue: 9, confidence: demand.length ? 7 : 5, effort: 5, risk: 2, executionType: "github_pr", riskLabel: "low", severity: "normal",
      service, newPage: true,
    });
  }

  for (const location of input.client.locations) {
    if (input.pages.some((p) => pageCovers(p, location))) continue;
    const demand = demandFor(location, input).filter((k) => k.impressions >= 50);
    if (!demand.length) continue; // only with proven local search demand (§10.2)
    out.push({
      type: "new_location_page", category: "content", family: "pages", actionKey: `location:${slug(location)}`,
      targetUrl: `/areas/${slug(location)}`, targetQuery: demand[0]!.keyword,
      title: `Create a page for customers in ${location}`,
      description: `People search for “${demand[0]!.keyword}” (${n(demand[0]!.impressions)} impressions, ${demand[0]!.period}) but no page covers ${location}.`,
      why: "Local searches favour pages that clearly serve that town.",
      proposedAction: `Add a ${location} page describing the services offered there, using only the client’s real services. Link it from the areas served section.`,
      expectedBenefit: "Visibility for searches that include the town name.",
      evidence: demand.slice(0, 3).map((k) => ({ source: "siteguru" as const, metric: "impressions", value: n(k.impressions), period: k.period, note: `“${k.keyword}”` })),
      impact: 7, commercialValue: 8, confidence: 6, effort: 5, risk: 2, executionType: "github_pr", riskLabel: "low", severity: "normal",
      location, newPage: true,
    });
  }
  return out;
}

/** Runs every rule whose inputs are present. Returns candidates plus the families that were evaluated. */
export function detect(input: DetectionInput): { candidates: Candidate[]; evaluated: Set<SignalFamily> } {
  const evaluated = new Set<SignalFamily>();
  const s = input.signals;
  if (s.todo) evaluated.add("todo");
  if (s.lowHangingFruit) evaluated.add("lowHangingFruit");
  if (s.declining) evaluated.add("declining");
  if (s.cannibalization) evaluated.add("cannibalization");
  if (s.topPages) evaluated.add("topPages");
  if (input.pages.length) evaluated.add("pages");
  const candidates = [
    ...fromTodo(input),
    ...fromLowHangingFruit(input),
    ...fromDeclining(input),
    ...fromCannibalization(input),
    ...fromTopPages(input),
    ...fromPages(input),
  ].filter((c) => c.evidence.length > 0); // §10.3: never without evidence
  return { candidates, evaluated };
}
