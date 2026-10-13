// Site audit (DataForSEO On-Page crawl) → to-do items in the Signals["todo"] shape, using the same
// check names the opportunity rules already handle. Counts are worked out from the crawled pages
// themselves rather than from undocumented summary keys.

import type { Signals } from "./opportunities/types";
import { pathOf } from "./gsc-signals";

export type AuditInput = {
  pages: {
    url?: string | null;
    status_code?: number | null;
    checks?: Record<string, boolean | null> | null;
    meta?: { title?: string | null; description?: string | null; htags?: Record<string, string[] | null> | null } | null;
  }[];
  brokenLinks: { page_from?: string | null; link_to?: string | null }[];
  linksToRedirects: { page_from?: string | null; link_to?: string | null }[];
  nonIndexable: { reason: string; url: string }[];
  domainChecks: Record<string, boolean | null>;
  /** Mobile PageSpeed scores for the most important pages. */
  speed: { url: string; score: number | null; lcpMs: number | null }[];
};

type Todo = NonNullable<Signals["todo"]>[number];

const list = (paths: string[], max = 5) => {
  const uniq = [...new Set(paths)];
  return uniq.slice(0, max).join(", ") + (uniq.length > max ? ` and ${uniq.length - max} more` : "");
};

export function auditToTodo(a: AuditInput): Signals["todo"] {
  const ok = a.pages.filter((p) => (p.status_code ?? 200) < 300 && p.url);
  const out: Todo[] = [];
  const push = (checkName: string, title: string, paths: string[], severity = "medium", extra = "") => {
    const uniq = [...new Set(paths)];
    if (!uniq.length) return;
    out.push({ checkName, severity, title, affectedPages: uniq.length, description: `${extra}${extra ? " " : ""}Pages: ${list(uniq)}.` });
  };

  if (a.domainChecks.sitemap === false) {
    out.push({ checkName: "siteMap", severity: "high", title: "XML sitemap", affectedPages: null, description: "The crawler did not find a sitemap for this site." });
  }

  const titles = new Map<string, string[]>();
  const descs = new Map<string, string[]>();
  for (const p of ok) {
    const t = p.meta?.title?.trim();
    if (t) titles.set(t.toLowerCase(), [...(titles.get(t.toLowerCase()) ?? []), pathOf(p.url!)]);
    const d = p.meta?.description?.trim();
    if (d) descs.set(d.toLowerCase(), [...(descs.get(d.toLowerCase()) ?? []), pathOf(p.url!)]);
  }
  const dupTitles = [...titles.values()].filter((v) => v.length > 1).flat();
  const dupDescs = [...descs.values()].filter((v) => v.length > 1).flat();

  push("pageTitles", "Missing or duplicate page titles", [...ok.filter((p) => !p.meta?.title?.trim()).map((p) => pathOf(p.url!)), ...dupTitles], "high");
  push("metaDescriptions", "Missing or duplicate meta descriptions", [...ok.filter((p) => !p.meta?.description?.trim()).map((p) => pathOf(p.url!)), ...dupDescs]);
  push("headings", "Pages without an H1 heading", ok.filter((p) => !(p.meta?.htags?.h1 ?? []).some((h) => h.trim())).map((p) => pathOf(p.url!)));
  push("imageAltTags", "Images without alt text", ok.filter((p) => p.checks?.no_image_alt === true).map((p) => pathOf(p.url!)), "low");
  push("orphanPages", "Pages nothing links to", ok.filter((p) => p.checks?.is_orphan_page === true).map((p) => pathOf(p.url!)), "medium", "Found in the sitemap but not linked from any page.");
  push("canonical", "Canonicals pointing at redirects", ok.filter((p) => p.checks?.canonical_to_redirect === true).map((p) => pathOf(p.url!)));
  push(
    "brokenLinks",
    "Broken internal links",
    a.brokenLinks.map((l) => pathOf(l.page_from ?? "")).filter((x) => x),
    "high",
    a.brokenLinks.length ? `${a.brokenLinks.length} broken link${a.brokenLinks.length === 1 ? "" : "s"}, e.g. to ${list(a.brokenLinks.map((l) => pathOf(l.link_to ?? "")), 3)}.` : "",
  );
  push("internalRedirects", "Internal links through redirects", a.linksToRedirects.map((l) => pathOf(l.page_from ?? "")).filter((x) => x), "low");
  push(
    "noindexNofollow",
    "Pages Google can’t index",
    a.nonIndexable.map((n) => pathOf(n.url)),
    "medium",
    `Reasons: ${[...new Set(a.nonIndexable.map((n) => n.reason.replace(/_/g, " ")))].join(", ")}.`,
  );
  const slow = a.speed.filter((s) => s.score != null && s.score < 50);
  if (slow.length) {
    push(
      "pageSpeed",
      "Slow pages on mobile",
      slow.map((s) => pathOf(s.url)),
      "medium",
      `Mobile speed scores: ${slow.map((s) => `${pathOf(s.url)} ${s.score}/100${s.lcpMs ? ` (largest content after ${(s.lcpMs / 1000).toFixed(1)}s)` : ""}`).join("; ")}.`,
    );
  }
  return out;
}
