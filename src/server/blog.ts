import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { blogCommitments, clients, opportunities, pages, siteguruSignals, tiers, type EvidenceItem } from "@/db/schema";
import { blogTopicCandidates, draftsDueBy, isBlogBehind, londonDayInfo, qualityCheck, slugify, type DemandKeyword } from "@/domain/blog";
import { opportunityFingerprint } from "@/domain/fingerprint";
import { numbersIn } from "@/domain/opportunities/text";
import type { Signals } from "@/domain/opportunities/types";
import { anthropicConfigured, llmJson } from "@/integrations/anthropic";
import { BLOG_DRAFT_SYSTEM, BLOG_PLAN_SYSTEM, BLOG_PROMPT_VERSION, blogDraftPrompt, blogDraftSchema, blogPlanPrompt, blogPlanSchema } from "@/integrations/anthropic/prompts/blog";
import { audit } from "@/lib/audit";
import { raiseAttention, resolveAttention } from "@/lib/attention";
import { formatMonthYear, periodOf } from "@/lib/format";
import { createApprovalBatch } from "./batches";

export type BlogTopic = { title: string; keyword: string; angle: string };
export type BlogDraft = { title: string; slug: string; body: string; meta_description: string };
export type BlogPayload = {
  period: string;
  blogState: "planned" | "drafted" | "qc_failed";
  topic: BlogTopic;
  draft?: BlogDraft;
  qcReasons?: string[];
  promptVersion?: string;
  newPage?: boolean;
};

const periodFilter = (period: string) => sql`${opportunities.payload}->>'period' = ${period}`;

async function loadClient(clientId: string) {
  const [row] = await db.select({ c: clients, t: tiers }).from(clients).innerJoin(tiers, eq(tiers.id, clients.tierId)).where(eq(clients.id, clientId));
  return row ?? null;
}

const isEligible = (c: typeof clients.$inferSelect) => c.status === "active" && !c.paused && !c.archivedAt;

export async function blogPostsForPeriod(clientId: string, period: string) {
  return db
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.clientId, clientId), eq(opportunities.isBlogCommitment, true), periodFilter(period)))
    .orderBy(opportunities.firstDetectedAt);
}

// ── Planning (1st of the month, §10.6) ─────────────────────────────────────────

/** Real demand: the latest stored SiteGuru keywords and low-hanging-fruit queries, strongest first. */
async function demandKeywords(clientId: string): Promise<DemandKeyword[]> {
  const [row] = await db
    .select({ signals: siteguruSignals.signals })
    .from(siteguruSignals)
    .where(eq(siteguruSignals.clientId, clientId))
    .orderBy(desc(siteguruSignals.capturedAt))
    .limit(1);
  const s = (row?.signals ?? {}) as Signals;
  const byKw = new Map<string, DemandKeyword>();
  const add = (keyword: string, impressions: number, position: number | null, period: string) => {
    const k = keyword.trim().toLowerCase();
    const prev = byKw.get(k);
    if (!prev || prev.impressions < impressions) byKw.set(k, { keyword: keyword.trim(), impressions, position, period });
  };
  for (const k of s.keywords ?? []) add(k.keyword, k.impressions, k.position, "last 30 days");
  for (const k of s.lowHangingFruit ?? []) add(k.keyword, k.impressions, k.avgPosition, "last 90 days");
  return [...byKw.values()];
}

const QUESTION_START = /^(how|what|why|when|where|which|who|can|does|do|is|are|should|will)\b/i;

/** Plain fallback wording when no LLM is available. Built only from the keyword itself. */
export function templateTopic(keyword: string): BlogTopic {
  const kw = keyword.trim().replace(/\s+/g, " ");
  const sentence = kw.charAt(0).toUpperCase() + kw.slice(1);
  const title = QUESTION_START.test(kw) ? `${sentence.replace(/\?$/, "")}?` : `A guide to ${kw}`;
  return { title, keyword: kw, angle: `Answer what people searching for “${kw}” want to know, using the business's own services and areas.` };
}

export type PlanOutcome = { status: "planned" | "skipped"; committed: number; planned: number; added: number; reason?: string };

/**
 * blog.plan for one client and month. Idempotent: tops the month up to N topics and never adds more.
 * Every topic comes from a real search query with impressions; if there aren't enough, it says so
 * (attention item) instead of inventing topics.
 */
export async function planBlogPosts(clientId: string, period: string): Promise<PlanOutcome> {
  const row = await loadClient(clientId);
  if (!row || !isEligible(row.c)) return { status: "skipped", committed: 0, planned: 0, added: 0, reason: "Client is not active" };
  const { c, t } = row;
  const committed = t.postsPerMonth;
  if (committed <= 0) return { status: "skipped", committed: 0, planned: 0, added: 0, reason: "Tier has no blog posts" };

  await db
    .insert(blogCommitments)
    .values({ clientId, period, committed })
    .onConflictDoUpdate({ target: [blogCommitments.clientId, blogCommitments.period], set: { committed } });

  // A declined post frees its slot, so re-planning can replace it.
  const existing = (await blogPostsForPeriod(clientId, period)).filter((o) => o.status !== "declined" && o.status !== "stale");
  const need = committed - existing.length;
  if (need <= 0) {
    await refreshBlogProgress(clientId, period);
    return { status: "planned", committed, planned: existing.length, added: 0 };
  }

  // Never repeat a keyword the client has already had a post planned for, in any month.
  const used = await db
    .select({ q: opportunities.targetQuery })
    .from(opportunities)
    .where(and(eq(opportunities.clientId, clientId), eq(opportunities.isBlogCommitment, true)));
  const usedKw = new Set(used.map((u) => (u.q ?? "").toLowerCase()));
  const inventory = await db.select({ path: pages.path, title: pages.title }).from(pages).where(eq(pages.clientId, clientId));
  const existingTitles = inventory.map((p) => p.title ?? "").filter(Boolean);

  const candidates = blogTopicCandidates({
    keywords: (await demandKeywords(clientId)).filter((k) => !usedKw.has(k.keyword.toLowerCase())),
    services: c.services,
    locations: c.locations,
    clientKeywords: c.keywords,
    excluded: [...c.excludedServices, ...c.excludedLocations],
    brandTerms: [c.name, c.domain.split(".")[0] ?? ""],
    existingTitles,
  }).slice(0, 25);

  let topics: BlogTopic[] = [];
  let promptVersion: string | undefined;
  if (candidates.length && (await anthropicConfigured())) {
    try {
      const out = await llmJson({
        schema: blogPlanSchema,
        schemaName: "blogPlan",
        system: BLOG_PLAN_SYSTEM,
        prompt: blogPlanPrompt({
          client: { name: c.name, industry: c.industry, services: c.services, locations: c.locations, excluded: [...c.excludedServices, ...c.excludedLocations] },
          count: need,
          keywords: candidates.map((k) => ({ keyword: k.keyword, impressions: k.impressions })),
          existingTitles,
        }),
      });
      // Constrained to the candidate keywords: anything else is dropped.
      const allowed = new Map(candidates.map((k) => [k.keyword.toLowerCase(), k.keyword]));
      const seen = new Set<string>();
      for (const tp of out.topics) {
        const kw = allowed.get(tp.keyword.trim().toLowerCase());
        if (!kw || seen.has(kw)) continue;
        seen.add(kw);
        topics.push({ title: tp.title, keyword: kw, angle: tp.angle });
      }
      promptVersion = BLOG_PROMPT_VERSION;
    } catch (e) {
      console.error("Blog topic planning failed; using keyword topics", e);
    }
  }
  // Top up from the strongest remaining candidates.
  for (const k of candidates) {
    if (topics.length >= need) break;
    if (!topics.some((tp) => tp.keyword === k.keyword)) topics.push(templateTopic(k.keyword));
  }
  topics = topics.slice(0, need);

  const demand = new Map(candidates.map((k) => [k.keyword, k]));
  let added = 0;
  for (const tp of topics) {
    const d = demand.get(tp.keyword)!;
    const slug = slugify(tp.keyword);
    const evidence: EvidenceItem[] = [
      { source: "siteguru", metric: "impressions", value: d.impressions, period: d.period, note: `Google searches for “${d.keyword}” that showed the site` },
      ...(d.position != null ? [{ source: "siteguru" as const, metric: "average position", value: Math.round(d.position * 10) / 10, period: d.period }] : []),
    ];
    const payload: BlogPayload = { period, blogState: "planned", topic: tp, promptVersion, newPage: true };
    const res = await db
      .insert(opportunities)
      .values({
        clientId,
        fingerprint: opportunityFingerprint({ clientId, type: "blog_content", targetQuery: d.keyword, actionKey: `blog:${period}:${slug}` }),
        type: "blog_content",
        category: "content",
        title: `Blog post: ${tp.title}`,
        description: `People searched Google for “${d.keyword}” and the site appeared ${d.impressions} times (${d.period}).`,
        why: "A helpful post answering this search can bring in visitors who are looking for exactly what the business offers.",
        proposedAction: `Write and publish a blog post: ${tp.title}. ${tp.angle}`,
        expectedBenefit: "More visitors from people researching this topic.",
        targetQuery: d.keyword,
        actionKey: `blog:${period}:${slug}`,
        evidence,
        executionType: "content_generation",
        impactLabel: "medium",
        status: "candidate",
        isBlogCommitment: true,
        payload,
        textSource: promptVersion ? "llm" : "template",
      })
      .onConflictDoNothing({ target: [opportunities.clientId, opportunities.fingerprint] })
      .returning({ id: opportunities.id });
    if (res.length) added++;
  }

  const planned = existing.length + added;
  const shortKey = `blog_topics_short:${clientId}:${period}`;
  if (planned < committed) {
    await raiseAttention({
      dedupeKey: shortKey,
      kind: "blog_commitment",
      clientId,
      title: `Only ${planned} of ${committed} blog topics found for ${c.name}`,
      detail: "There isn’t enough real search demand in SiteGuru to plan every post this month. Add target keywords in the client’s settings, then tap Plan blog posts.",
      link: `/clients/${clientId}/settings`,
    });
  } else {
    await resolveAttention(shortKey);
  }
  await refreshBlogProgress(clientId, period);
  await audit({ actor: "system", clientId, entityType: "blog_commitment", event: "blog.planned", after: { period, committed, planned, added, topics: topics.map((x) => x.keyword) } });
  return { status: "planned", committed, planned, added };
}

// ── Drafting (weekly waves) ────────────────────────────────────────────────────

/** The site's blog folder, from the crawled inventory ("/blog" when there isn't one yet). */
export function blogBase(paths: { path: string; pageType: string }[]): string {
  const counts = new Map<string, number>();
  for (const p of paths) {
    if (p.pageType !== "blog") continue;
    const parent = p.path.replace(/\/$/, "").split("/").slice(0, -1).join("/");
    if (parent) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best?.[0] ?? "/blog";
}

type DraftResult = { id: string; ok: boolean; reasons?: string[] };

async function draftOne(
  opp: typeof opportunities.$inferSelect,
  c: typeof clients.$inferSelect,
  ctx: { base: string; existingPaths: string[]; existingTitles: string[] },
): Promise<DraftResult> {
  const p = opp.payload as BlogPayload;
  const excluded = [...c.excludedServices, ...c.excludedLocations];
  const allowedNumbers = [p.topic.title, p.topic.keyword, ...c.services, ...c.locations, c.name].flatMap(numbersIn);
  let reasons: string[] = [];
  let draft: BlogDraft | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await llmJson({
      schema: blogDraftSchema,
      schemaName: "blogDraft",
      system: BLOG_DRAFT_SYSTEM,
      effort: "medium",
      prompt: blogDraftPrompt({
        client: { name: c.name, tone: c.brandTone, services: c.services, locations: c.locations, excluded },
        topic: p.topic,
        retryReasons: attempt ? reasons : undefined,
      }),
    });
    const slug = slugify(out.slug || out.title) || slugify(p.topic.keyword);
    const candidate = { title: out.title, slug, body: out.body_markdown, meta_description: out.meta_description };
    reasons = qualityCheck(
      { title: candidate.title, slug, body: candidate.body, metaDescription: candidate.meta_description, targetKeyword: p.topic.keyword },
      { existingPaths: ctx.existingPaths, existingTitles: ctx.existingTitles, excluded, allowedNumbers },
    );
    if (!reasons.length) {
      draft = candidate;
      break;
    }
  }

  if (!draft) {
    await db
      .update(opportunities)
      .set({ payload: { ...p, blogState: "qc_failed", qcReasons: reasons } satisfies BlogPayload })
      .where(eq(opportunities.id, opp.id));
    await raiseAttention({
      dedupeKey: `blog_qc:${opp.id}`,
      kind: "blog_commitment",
      clientId: c.id,
      title: `Blog draft failed quality checks for ${c.name}`,
      detail: `“${p.topic.title}”: ${reasons.slice(0, 3).join("; ")}. It will be tried again in next week’s wave.`,
      link: `/clients/${c.id}/recommendations`,
    });
    await audit({ actor: "system", clientId: c.id, entityType: "opportunity", entityId: opp.id, event: "blog.qc_failed", after: { reasons } });
    return { id: opp.id, ok: false, reasons };
  }

  const path = `${ctx.base}/${draft.slug}`;
  ctx.existingPaths.push(path);
  ctx.existingTitles.push(draft.title);
  await db
    .update(opportunities)
    .set({
      title: `Publish blog post: ${draft.title}`,
      description: draft.meta_description,
      proposedAction: `Add the drafted post as a new blog post at ${path}, using the site’s existing blog layout. Use the content as written.`,
      targetUrl: path,
      payload: { ...p, blogState: "drafted", draft, qcReasons: undefined, promptVersion: BLOG_PROMPT_VERSION } satisfies BlogPayload,
      status: "recommended",
      timesRecommended: sql`${opportunities.timesRecommended} + 1`,
      textSource: "llm",
    })
    .where(and(eq(opportunities.id, opp.id), eq(opportunities.status, "candidate")));
  await resolveAttention(`blog_qc:${opp.id}`);
  await audit({ actor: "system", clientId: c.id, entityType: "opportunity", entityId: opp.id, event: "blog.drafted", after: { title: draft.title, path, words: draft.body.split(/\s+/).length } });
  return { id: opp.id, ok: true };
}

export type WaveOutcome = { status: "drafted" | "skipped"; drafted: number; failed: number; due: number; autoBatchId?: string; reason?: string };

/**
 * blog.draft_wave for one client: drafts just enough posts to keep pace with the month
 * (N spread across the weeks). Review on → the drafts appear as Content recommendations.
 * Review off → they're auto-approved into a batch (still a PR that needs merging).
 */
export async function draftBlogWave(clientId: string, now = new Date()): Promise<WaveOutcome> {
  const row = await loadClient(clientId);
  if (!row || !isEligible(row.c)) return { status: "skipped", drafted: 0, failed: 0, due: 0, reason: "Client is not active" };
  const { c } = row;
  const period = periodOf(now);
  const [commitment] = await db.select().from(blogCommitments).where(and(eq(blogCommitments.clientId, clientId), eq(blogCommitments.period, period)));
  if (!commitment || commitment.committed <= 0) return { status: "skipped", drafted: 0, failed: 0, due: 0, reason: "No blog commitment this month" };

  const posts = await blogPostsForPeriod(clientId, period);
  const { dayOfMonth, daysInMonth } = londonDayInfo(now);
  const due = draftsDueBy(commitment.committed, dayOfMonth, daysInMonth);
  const drafted = posts.filter((o) => (o.payload as BlogPayload).draft).length;
  const todo = posts.filter((o) => o.status === "candidate" && !(o.payload as BlogPayload).draft).slice(0, Math.max(0, due - drafted));
  if (!todo.length) return { status: "drafted", drafted: 0, failed: 0, due };

  if (!(await anthropicConfigured())) {
    await raiseAttention({
      dedupeKey: `blog_no_llm:${clientId}:${period}`,
      kind: "blog_commitment",
      clientId,
      title: `Blog posts for ${c.name} can’t be drafted`,
      detail: "Drafting needs an Anthropic API key. Add one in Settings → Integrations.",
      link: "/settings/integrations",
    });
    return { status: "skipped", drafted: 0, failed: 0, due, reason: "No Anthropic key" };
  }
  await resolveAttention(`blog_no_llm:${clientId}:${period}`);

  const inventory = await db.select({ path: pages.path, title: pages.title, pageType: pages.pageType }).from(pages).where(eq(pages.clientId, clientId));
  const otherDrafts = posts.flatMap((o) => {
    const d = (o.payload as BlogPayload).draft;
    return d ? [{ path: o.targetUrl ?? "", title: d.title }] : [];
  });
  const ctx = {
    base: blogBase(inventory),
    existingPaths: [...inventory.map((p) => p.path), ...otherDrafts.map((d) => d.path)],
    existingTitles: [...inventory.map((p) => p.title ?? "").filter(Boolean), ...otherDrafts.map((d) => d.title)],
  };

  const results: DraftResult[] = [];
  for (const opp of todo) results.push(await draftOne(opp, c, ctx));
  const ok = results.filter((r) => r.ok).map((r) => r.id);

  let autoBatchId: string | undefined;
  if (ok.length && !c.reviewBlogPosts) {
    const res = await createApprovalBatch({ clientId, opportunityIds: ok, idempotencyKey: `blog-${clientId}-${ok.sort().join(",").slice(0, 200)}`, undoWindowSeconds: 0, auto: true });
    if (res.count) autoBatchId = res.batch.id;
  }
  await refreshBlogProgress(clientId, period);
  return { status: "drafted", drafted: ok.length, failed: results.length - ok.length, due, autoBatchId };
}

// ── Progress and behind-schedule check ───────────────────────────────────────────

/** Recomputes the header counts from the posts themselves. A post counts as published when it's live. */
export async function refreshBlogProgress(clientId: string, period: string) {
  const posts = await blogPostsForPeriod(clientId, period);
  const active = posts.filter((o) => o.status !== "declined" && o.status !== "stale");
  const counts = {
    planned: active.length,
    drafted: posts.filter((o) => (o.payload as BlogPayload).draft).length,
    approved: posts.filter((o) => ["approved", "executing", "completed"].includes(o.status)).length,
    published: posts.filter((o) => o.status === "completed").length,
  };
  await db.update(blogCommitments).set(counts).where(and(eq(blogCommitments.clientId, clientId), eq(blogCommitments.period, period)));
  return counts;
}

/** blog.commitment_check: final 7 days of the month and fewer than N approved → attention item. */
export async function checkBlogCommitment(clientId: string, now = new Date()): Promise<{ behind: boolean }> {
  const period = periodOf(now);
  const key = `blog_behind:${clientId}:${period}`;
  const row = await loadClient(clientId);
  const [commitment] = await db.select().from(blogCommitments).where(and(eq(blogCommitments.clientId, clientId), eq(blogCommitments.period, period)));
  if (!row || !isEligible(row.c) || !commitment) {
    await resolveAttention(key);
    return { behind: false };
  }
  const counts = await refreshBlogProgress(clientId, period);
  const behind = isBlogBehind({ committed: commitment.committed, approved: counts.approved, now, ...londonDayInfo(now) });
  if (behind) {
    const left = commitment.committed - counts.approved;
    await raiseAttention({
      dedupeKey: key,
      kind: "blog_commitment",
      clientId,
      title: `${row.c.name}: ${left} of ${commitment.committed} blog posts still to approve`,
      detail: `${formatMonthYear(period)} ends soon. Approve the drafted posts so they can go live this month.`,
      link: `/clients/${clientId}/recommendations`,
    });
  } else {
    await resolveAttention(key);
  }
  return { behind };
}
