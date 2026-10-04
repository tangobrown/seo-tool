import "server-only";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { clients, opportunities, pages, siteguruSignals, workspace } from "@/db/schema";
import { resolveScoring } from "@/domain/opportunities/config";
import { detect } from "@/domain/opportunities/detect";
import { forceManualIfUnsafe, violatesStrategy } from "@/domain/opportunities/guards";
import { reconcile, type ExistingOpportunity } from "@/domain/opportunities/reconcile";
import { impactLabel, scoreCandidates } from "@/domain/opportunities/score";
import { selectRecommendations } from "@/domain/opportunities/select";
import { onlyKnownNumbers } from "@/domain/opportunities/text";
import { familyOf, NEW_PAGE_TYPES, type DetectionInput, type ScoredCandidate, type Signals } from "@/domain/opportunities/types";
import { anthropicConfigured, llmJson } from "@/integrations/anthropic";
import { REC_TEXT_PROMPT_VERSION, REC_TEXT_SYSTEM, recTextPrompt, recTextSchema } from "@/integrations/anthropic/prompts/recommendations";
import { siteguru } from "@/integrations/siteguru";
import { toSignals } from "@/integrations/siteguru/map";
import { audit } from "@/lib/audit";
import { raiseAttention, resolveAttention } from "@/lib/attention";
import { createApprovalBatch } from "./batches";
import { syncClientFromSiteguru } from "./siteguru-sync";

type CandidatePayload = { service?: string | null; location?: string | null; newPage?: boolean; autoApproveKind?: string; promptVersion?: string };

// ── Step 1: sync SiteGuru and capture detection signals ───────────────────────────

/**
 * Fetches each signal family independently. A failed family is recorded and left out, so detection
 * runs on what we have and never mistakes "fetch failed" for "issue fixed".
 */
export async function captureSignals(clientId: string): Promise<{ signalsId: string | null; errors: string[] }> {
  const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!c) throw new Error(`Client ${clientId} not found`);
  if (!c.siteguruSiteId) return { signalsId: null, errors: ["No SiteGuru site linked"] };
  const site = c.siteguruSiteId;

  await syncClientFromSiteguru(clientId); // KPIs first (§10.1); throws if SiteGuru is down, so the step retries

  const errors: string[] = [];
  const attempt = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };
  const [todo, lowHangingFruit, declining, cannibalization, overview, keywords] = await Promise.all([
    attempt("todo", () => siteguru.todoList(site)),
    attempt("low hanging fruit", () => siteguru.lowHangingFruit(site, { range: "last_90_days" })),
    attempt("declining content", () => siteguru.decliningContent(site)),
    attempt("cannibalization", () => siteguru.cannibalization(site, { range: "last_90_days" })),
    attempt("traffic overview", () => siteguru.trafficOverview(site, { range: "last_30_days" })),
    attempt("top keywords", () => siteguru.topKeywords(site, { range: "last_30_days" })),
  ]);
  const signals = toSignals({ todo, lowHangingFruit, declining, cannibalization, overview, keywords });
  const [row] = await db
    .insert(siteguruSignals)
    .values({ clientId, signals: { ...signals, fetchErrors: errors } })
    .returning({ id: siteguruSignals.id });
  return { signalsId: row!.id, errors };
}

// ── Step 2: detect → score → reconcile → select ───────────────────────────────

export type ScanOutcome = {
  detected: number;
  inserted: number;
  recommended: number;
  newlyRecommended: string[];
  reserve: number;
  stale: number;
};

function monthStart(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function candidateColumns(c: ScoredCandidate) {
  return {
    type: c.type,
    category: c.category,
    targetUrl: c.targetUrl,
    targetQuery: c.targetQuery,
    actionKey: c.actionKey,
    evidence: c.evidence,
    evidenceHash: c.evidenceHash,
    impact: c.impact,
    commercialValue: c.commercialValue,
    confidence: c.confidence,
    effort: c.effort,
    risk: c.risk,
    priorityScore: c.priorityScore,
    impactLabel: c.impactLabel,
    riskLabel: c.riskLabel,
    executionType: c.executionType,
    severity: c.severity,
  };
}

function templateText(c: ScoredCandidate) {
  return {
    title: c.title,
    description: c.description,
    why: c.why,
    proposedAction: c.proposedAction,
    expectedBenefit: c.expectedBenefit,
    textSource: "template",
  };
}

function payloadOf(c: ScoredCandidate, prev?: Record<string, unknown> | null): CandidatePayload & Record<string, unknown> {
  return { ...(prev ?? {}), service: c.service ?? null, location: c.location ?? null, newPage: !!c.newPage, autoApproveKind: c.autoApproveKind };
}

export async function runDetection(clientId: string, signalsId: string | null, now = new Date()): Promise<ScanOutcome> {
  const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!c) throw new Error(`Client ${clientId} not found`);
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, 1));
  const cfg = resolveScoring(c.weightingMode === "custom" && c.weights ? { ...ws?.scoring, weights: c.weights as never } : ws?.scoring);

  let signals: Signals = {};
  if (signalsId) {
    const [row] = await db.select().from(siteguruSignals).where(eq(siteguruSignals.id, signalsId));
    const { fetchErrors: _ignored, ...rest } = (row?.signals ?? {}) as Signals & { fetchErrors?: unknown };
    void _ignored;
    signals = rest;
  }
  const inventory = await db
    .select({ path: pages.path, pageType: pages.pageType, service: pages.service, location: pages.location, title: pages.title, h1: pages.h1, internalLinksIn: pages.internalLinksIn })
    .from(pages)
    .where(eq(pages.clientId, clientId));

  const client: DetectionInput["client"] = {
    id: c.id,
    domain: c.domain,
    services: c.services,
    priorityServices: c.priorityServices,
    locations: c.locations,
    excludedServices: c.excludedServices,
    excludedLocations: c.excludedLocations,
    keywords: c.keywords,
  };
  const { candidates, evaluated } = detect({ client, pages: inventory, signals });
  const scored = scoreCandidates(candidates.map(forceManualIfUnsafe), client, cfg);

  const existingRows = await db.select().from(opportunities).where(eq(opportunities.clientId, clientId));
  const existing: ExistingOpportunity[] = existingRows.map((o) => ({
    id: o.id,
    fingerprint: o.fingerprint,
    type: o.type,
    status: o.status,
    evidenceHash: o.evidenceHash,
    priorityScore: o.priorityScore,
    scoreAtDecision: o.scoreAtDecision,
    decidedAt: o.decidedAt,
    deferredUntil: o.deferredUntil,
    missedScans: o.missedScans,
    family: familyOf(o.actionKey),
  }));
  const plan = reconcile({ existing, candidates: scored, evaluated, candidateFamily: (x) => x.family, now, cfg });
  const prevById = new Map(existingRows.map((o) => [o.id, o]));

  return db.transaction(async (tx) => {
    for (const ins of plan.inserts) {
      await tx
        .insert(opportunities)
        .values({ clientId, fingerprint: ins.fingerprint, ...candidateColumns(ins), ...templateText(ins), payload: payloadOf(ins), status: "candidate", firstDetectedAt: now, lastDetectedAt: now })
        .onConflictDoNothing({ target: [opportunities.clientId, opportunities.fingerprint] });
    }
    for (const r of plan.refreshes) {
      const prev = prevById.get(r.id);
      const keepLlmText = prev?.textSource === "llm" && !r.evidenceChanged;
      await tx
        .update(opportunities)
        .set({
          ...candidateColumns(r.candidate),
          ...(keepLlmText ? {} : templateText(r.candidate)),
          payload: payloadOf(r.candidate, prev?.payload),
          lastDetectedAt: now,
          missedScans: 0,
          ...(r.status ? { status: r.status as "candidate", deferredUntil: null, statusNote: null } : {}),
        })
        .where(eq(opportunities.id, r.id));
    }
    for (const m of plan.missed) {
      await tx
        .update(opportunities)
        .set({ missedScans: m.missedScans, ...(m.status ? { status: m.status, statusNote: "No longer detected" } : {}) })
        .where(eq(opportunities.id, m.id));
    }

    // Selection over the whole backlog, not just this scan's finds.
    const pool = await tx
      .select()
      .from(opportunities)
      .where(and(eq(opportunities.clientId, clientId), inArray(opportunities.status, ["candidate", "reserve", "recommended"])));
    const [{ n: newPagesApproved } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(opportunities)
      .where(
        and(
          eq(opportunities.clientId, clientId),
          inArray(opportunities.type, [...NEW_PAGE_TYPES]),
          inArray(opportunities.status, ["approved", "executing", "completed"]),
          gte(opportunities.decidedAt, monthStart(now)),
        ),
      );
    const newPagesRecommended = pool.filter((o) => NEW_PAGE_TYPES.has(o.type) && o.status === "recommended").length;
    const guard = new Map(
      pool.map((o) => {
        const p = (o.payload ?? {}) as CandidatePayload;
        return [o.id, violatesStrategy({ type: o.type, title: o.title, targetQuery: o.targetQuery, targetUrl: o.targetUrl, service: p.service ?? null, location: p.location ?? null }, client)];
      }),
    );
    const sel = selectRecommendations({
      pool: pool.map((o) => ({
        id: o.id,
        type: o.type,
        status: o.status,
        priorityScore: o.priorityScore,
        severity: o.severity,
        guardViolation: guard.get(o.id) ?? null,
        isBlogCommitment: o.isBlogCommitment,
      })),
      cfg,
      recsPerScan: ws?.recsPerScan ?? 10,
      minScore: ws?.minScore ?? 65,
      newPagesUsedThisMonth: newPagesApproved + newPagesRecommended,
    });

    const wasRecommended = new Set(pool.filter((o) => o.status === "recommended").map((o) => o.id));
    const newlyRecommended = sel.recommended.filter((id) => !wasRecommended.has(id));
    if (newlyRecommended.length) {
      await tx
        .update(opportunities)
        .set({ status: "recommended", timesRecommended: sql`${opportunities.timesRecommended} + 1`, statusNote: null })
        .where(inArray(opportunities.id, newlyRecommended));
    }
    if (sel.reserve.length) await tx.update(opportunities).set({ status: "reserve" }).where(inArray(opportunities.id, sel.reserve));
    for (const id of sel.candidate) {
      await tx.update(opportunities).set({ status: "candidate", statusNote: guard.get(id) ?? "Below the minimum score" }).where(eq(opportunities.id, id));
    }

    const outcome: ScanOutcome = {
      detected: scored.length,
      inserted: plan.inserts.length,
      recommended: sel.recommended.length,
      newlyRecommended,
      reserve: sel.reserve.length,
      stale: plan.missed.filter((m) => m.status === "stale").length,
    };
    await audit(
      { actor: "system", clientId, entityType: "scan", event: "scan.completed", after: { ...outcome, newlyRecommended: newlyRecommended.length, thresholds: cfg.thresholds } },
      tx,
    );
    return outcome;
  });
}

// ── Step 3: wording from evidence (LLM) ────────────────────────────────────────

/** Rewrites template text for recommended items. Any failure keeps the factual template text. */
export async function writeRecommendationText(clientId: string): Promise<{ rewritten: number; kept: number; skipped?: string }> {
  if (!(await anthropicConfigured())) return { rewritten: 0, kept: 0, skipped: "No Anthropic key" };
  const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
  const rows = await db
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.clientId, clientId), eq(opportunities.status, "recommended"), eq(opportunities.textSource, "template")))
    .orderBy(desc(opportunities.priorityScore))
    .limit(20);
  if (!rows.length || !c) return { rewritten: 0, kept: 0 };

  let out: Awaited<ReturnType<typeof llmJson<typeof recTextSchema>>>;
  try {
    out = await llmJson({
      schema: recTextSchema,
      schemaName: "recommendationText",
      system: REC_TEXT_SYSTEM,
      prompt: recTextPrompt({
        client: { name: c.name, tone: c.brandTone },
        items: rows.map((r) => ({
          id: r.id,
          draft: { title: r.title, description: r.description, why: r.why, proposed_action: r.proposedAction, expected_benefit: r.expectedBenefit },
          evidence: r.evidence,
        })),
      }),
    });
  } catch (e) {
    await raiseAttention({
      dedupeKey: `rec_text_failed:${clientId}`,
      kind: "integration",
      clientId,
      title: "Recommendation wording failed",
      detail: `Showing the plain drafts instead. ${e instanceof Error ? e.message.slice(0, 160) : ""}`,
      link: "/settings/integrations",
    });
    return { rewritten: 0, kept: rows.length };
  }
  await resolveAttention(`rec_text_failed:${clientId}`);

  let rewritten = 0;
  for (const r of rows) {
    const t = out.items.find((i) => i.id === r.id);
    if (!t) continue;
    const source = [r.title, r.description, r.why, r.proposedAction, r.expectedBenefit, JSON.stringify(r.evidence)];
    if (!onlyKnownNumbers([t.title, t.description, t.why, t.proposed_action, t.expected_benefit], source)) continue; // §9.6 guard
    await db
      .update(opportunities)
      .set({
        title: t.title,
        description: t.description,
        why: t.why,
        proposedAction: t.proposed_action,
        expectedBenefit: t.expected_benefit,
        textSource: "llm",
        payload: { ...(r.payload ?? {}), promptVersion: REC_TEXT_PROMPT_VERSION },
      })
      .where(and(eq(opportunities.id, r.id), eq(opportunities.textSource, "template")));
    rewritten++;
  }
  return { rewritten, kept: rows.length - rewritten };
}

// ── Step 4: auto-approve low-impact fixes ──────────────────────────────────────

/** Alt text, schema markup and image compression skip review when the client allows it. Still a PR. */
export async function autoApproveLowImpact(clientId: string, scanKey: string): Promise<{ batchId: string; count: number } | null> {
  const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!c?.autoApproveLowImpact || c.paused) return null;
  const rows = await db
    .select({ id: opportunities.id, payload: opportunities.payload, executionType: opportunities.executionType })
    .from(opportunities)
    .where(and(eq(opportunities.clientId, clientId), eq(opportunities.status, "recommended")));
  const ids = rows.filter((r) => r.executionType === "github_pr" && (r.payload as CandidatePayload | null)?.autoApproveKind).map((r) => r.id);
  if (!ids.length) return null;
  const res = await createApprovalBatch({ clientId, opportunityIds: ids, idempotencyKey: `auto-${scanKey}`, undoWindowSeconds: 0, auto: true });
  return res.count ? { batchId: res.batch.id, count: res.count } : null;
}

export { impactLabel };
