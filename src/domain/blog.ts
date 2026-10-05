/** §10.6: behind schedule = within the final 7 days of the month and fewer than N posts approved. */
export function isBlogBehind(input: { committed: number; approved: number; now: Date; daysInMonth: number; dayOfMonth: number }): boolean {
  if (input.committed <= 0) return false;
  const inFinalWeek = input.daysInMonth - input.dayOfMonth < 7;
  return inFinalWeek && input.approved < input.committed;
}

export function londonDayInfo(now: Date): { dayOfMonth: number; daysInMonth: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "numeric", day: "numeric", timeZone: "Europe/London" }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  return { dayOfMonth: d, daysInMonth: new Date(Date.UTC(y, m, 0)).getUTCDate() };
}

// ── Topic candidates (§10.6: every topic carries evidence; never invent one) ─────

export type DemandKeyword = { keyword: string; impressions: number; position: number | null; period: string };

const QUESTION = /^(how|what|why|when|where|which|who|can|does|do|is|are|should|will)\b|\b(vs|versus|cost|price|prices|best|guide|tips|ideas|benefits|near me)\b/i;

function norm(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Keywords that make good blog topics: question-style or informational, related to the client's
 * services or locations (or their own target keywords), not brand searches, not excluded, and not
 * already the exact subject of an existing page. Strongest demand first.
 */
export function blogTopicCandidates(input: {
  keywords: DemandKeyword[];
  services: string[];
  locations: string[];
  clientKeywords: string[];
  excluded: string[];
  brandTerms: string[];
  existingTitles: string[];
}): DemandKeyword[] {
  const related = [...input.services, ...input.locations, ...input.clientKeywords].map(norm).filter(Boolean);
  const relatedWords = new Set(related.flatMap((r) => r.split(" ")).filter((w) => w.length > 3));
  const excluded = input.excluded.map(norm).filter(Boolean);
  const brand = input.brandTerms.map(norm).filter((b) => b.length > 2);
  const titles = input.existingTitles.map(norm);
  const seen = new Set<string>();
  return input.keywords
    .filter((k) => {
      const kw = norm(k.keyword);
      if (!kw || seen.has(kw)) return false;
      seen.add(kw);
      if (k.impressions < 20) return false;
      if (brand.some((b) => kw.includes(b))) return false;
      if (excluded.some((x) => kw.includes(x))) return false;
      if (titles.some((t) => t === kw || t.includes(kw))) return false;
      const isRelated = related.some((r) => kw.includes(r)) || kw.split(" ").some((w) => relatedWords.has(w));
      return isRelated && (QUESTION.test(kw) || kw.split(" ").length >= 3);
    })
    .sort((a, b) => b.impressions - a.impressions);
}

export function slugify(s: string): string {
  return norm(s).replace(/ /g, "-").slice(0, 80);
}

// ── Drafting schedule (weekly waves) ─────────────────────────────────────────

/** How many posts should be drafted by this day of the month, spreading N across the weeks. */
export function draftsDueBy(committed: number, dayOfMonth: number, daysInMonth: number): number {
  if (committed <= 0) return 0;
  const weeks = Math.ceil(daysInMonth / 7);
  const week = Math.min(weeks, Math.floor((dayOfMonth - 1) / 7) + 1);
  return Math.min(committed, Math.ceil((committed * week) / weeks));
}

// ── Quality check (§10.6) ────────────────────────────────────────────────────

export type DraftForQc = { title: string; slug: string; body: string; metaDescription: string; targetKeyword: string };

export function wordCount(s: string): number {
  return (s.match(/[A-Za-z0-9’']+/g) ?? []).length;
}

/**
 * Deterministic checks. Rejects thin posts, keyword stuffing, duplicates of existing pages,
 * unverifiable claims (testimonials, credentials, statistics) and excluded services/locations.
 * Returns the reasons it failed; empty means it passed.
 */
export function qualityCheck(
  d: DraftForQc,
  ctx: { existingPaths: string[]; existingTitles: string[]; excluded: string[]; allowedNumbers: string[] },
): string[] {
  const reasons: string[] = [];
  const words = wordCount(d.body);
  if (words < 600) reasons.push(`Too thin: ${words} words (minimum 600)`);
  if (!d.metaDescription || d.metaDescription.length > 160) reasons.push("Meta description missing or over 160 characters");

  const kw = norm(d.targetKeyword);
  if (kw) {
    const occurrences = (norm(d.body).match(new RegExp(`\\b${kw.replace(/ /g, "\\s+")}\\b`, "g")) ?? []).length;
    const density = (occurrences * kw.split(" ").length) / Math.max(words, 1);
    if (density > 0.03) reasons.push(`Keyword stuffing: “${d.targetKeyword}” is ${(density * 100).toFixed(1)}% of the text`);
  }

  if (ctx.existingPaths.some((p) => p.replace(/\/$/, "").endsWith(`/${d.slug}`))) reasons.push("Duplicates an existing page (same URL)");
  if (ctx.existingTitles.map(norm).includes(norm(d.title))) reasons.push("Duplicates an existing page (same title)");

  const text = `${d.title}\n${d.body}`;
  if (/[“"][^”"]{20,}[”"]\s*[—–-]\s*[A-Z][a-z]+/.test(text) || /\b(said|says) (one|a) (customer|client)\b/i.test(text) || /★/.test(text)) {
    reasons.push("Contains a testimonial or review");
  }
  if (/\b(award[- ]winning|accredited|certified|qualified|registered|licensed|insured|guaranteed|no\.?\s?1|number one|leading)\b/i.test(text)) {
    reasons.push("Contains an unverifiable credential or claim");
  }
  // Numbers: list counts (2–10) and years are fine; anything else must come from the brief/evidence.
  const allowed = new Set(ctx.allowedNumbers.map((x) => x.replace(/,/g, "")));
  const stray = (text.match(/£\s?\d[\d,.]*|\d[\d,]*(\.\d+)?%|\b\d[\d,]{2,}(\.\d+)?\b/g) ?? []).filter((raw) => {
    const num = raw.replace(/[£%,\s]/g, "");
    if (/^(19|20)\d\d$/.test(num)) return false;
    return !allowed.has(num);
  });
  if (stray.length) reasons.push(`Unverifiable figures: ${[...new Set(stray)].slice(0, 3).join(", ")}`);

  for (const x of ctx.excluded) {
    if (x.trim() && norm(text).includes(norm(x))) reasons.push(`Mentions excluded “${x}”`);
  }
  return reasons;
}
