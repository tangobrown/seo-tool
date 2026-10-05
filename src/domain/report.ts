// Monthly report facts (§12.1). Every number in a report comes from here, computed by code.
// The LLM only rewords; it never supplies figures.

import type { ReportSection } from "@/db/schema";

export type ReportInput = {
  periodLabel: string; // "October 2026"
  prevMonthName: string; // "September"
  metrics: {
    source: "month" | "rolling";
    /** Human label for the data window, e.g. "1–31 October" or "2–29 October". */
    window: string;
    clicks: number | null;
    prevClicks: number | null;
    impressions: number | null;
    prevImpressions: number | null;
  } | null;
  work: { title: string; type: string }[];
  next: { title: string }[];
};

const nf = new Intl.NumberFormat("en-GB");
const n = (x: number) => nf.format(Math.round(x));

export function pctChange(curr: number | null, prev: number | null): number | null {
  if (curr == null || prev == null || prev <= 0) return null;
  return Math.round(((curr - prev) / prev) * 100);
}

/** "up 12% on September" / "down 6% on September" / "level with September" */
export function changePhrase(pct: number | null, against: string): string {
  if (pct === null) return "";
  if (pct === 0) return `level with ${against}`;
  return `${pct > 0 ? "up" : "down"} ${Math.abs(pct)}% on ${against}`;
}

/** "How it performed": factual bullets, numbers inserted by code. Empty when no verified data. */
export function performanceBullets(input: ReportInput): string[] {
  const m = input.metrics;
  if (!m) return [];
  const against = m.source === "month" ? input.prevMonthName : "the previous 30 days";
  const out: string[] = [];
  if (m.clicks != null) {
    const c = changePhrase(pctChange(m.clicks, m.prevClicks), against);
    out.push(`Visitors from Google search: ${n(m.clicks)}${c ? ` (${c})` : ""}`);
  }
  if (m.impressions != null) {
    const c = changePhrase(pctChange(m.impressions, m.prevImpressions), against);
    out.push(`Times the site appeared in Google results: ${n(m.impressions)}${c ? ` (${c})` : ""}`);
  }
  if (out.length && m.source === "rolling") out.push(`Figures cover ${m.window}, because Google reports search data a few days behind.`);
  return out;
}

const PLAIN_TYPE: Record<string, string> = {
  blog_content: "Published a new blog post",
  new_service_page: "Created a new page",
  new_location_page: "Created a new area page",
};

/** "What we did": plain-English fallbacks from completed work titles. */
export function workBullets(input: ReportInput): string[] {
  if (!input.work.length) return ["Set up tracking and completed the first site review"];
  return input.work.slice(0, 8).map((w) => (PLAIN_TYPE[w.type] ? `${PLAIN_TYPE[w.type]}: ${w.title.replace(/^Publish blog post:\s*/i, "")}` : w.title));
}

export function nextBullets(input: ReportInput): string[] {
  return input.next.slice(0, 5).map((x) => x.title);
}

/** Factual summary used when no LLM is available. States a decline plainly. */
export function templateSummary(input: ReportInput, domain: string): string {
  const m = input.metrics;
  const parts: string[] = [];
  if (m?.clicks != null) {
    const pct = pctChange(m.clicks, m.prevClicks);
    const c = changePhrase(pct, m.source === "month" ? input.prevMonthName : "the previous 30 days");
    parts.push(`In ${input.periodLabel.split(" ")[0]}, Google search brought ${n(m.clicks)} visitors to ${domain}${c ? `, ${c}` : ""}.`);
    if (pct !== null && pct < 0) parts.push("We’re looking into the drop and the work planned below is aimed at turning it around.");
  }
  const w = input.work.length;
  parts.push(w ? `We completed ${w} improvement${w === 1 ? "" : "s"} to the site this month.` : "This month we focused on reviewing the site and planning the first improvements.");
  return parts.join(" ");
}

export function buildSections(perf: string[], work: string[], next: string[]): ReportSection[] {
  const s: ReportSection[] = [{ title: "What we did", items: work }];
  if (perf.length) s.push({ title: "How it performed", items: perf });
  if (next.length) s.push({ title: "Next month", items: next });
  return s;
}
