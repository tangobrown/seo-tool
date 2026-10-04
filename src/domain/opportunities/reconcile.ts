import type { ScoringConfig } from "./config";
import type { ScoredCandidate, SignalFamily } from "./types";

export type ExistingOpportunity = {
  id: string;
  fingerprint: string;
  type: string;
  status: string;
  evidenceHash: string | null;
  priorityScore: number;
  scoreAtDecision: number | null;
  decidedAt: Date | null;
  deferredUntil: Date | null;
  missedScans: number;
  family: SignalFamily | null;
};

export type ReconcilePlan = {
  inserts: ScoredCandidate[];
  /** Existing rows refreshed with this scan's detection (evidence, scores, text), plus status changes. */
  refreshes: { id: string; candidate: ScoredCandidate; status?: string; evidenceChanged: boolean }[];
  /** Existing rows not detected this scan. */
  missed: { id: string; missedScans: number; status?: "stale" }[];
};

const ACTIVE = new Set(["candidate", "reserve", "recommended"]);

/**
 * §10.4 deduplication and suppression. Pure: given what's stored and what was just detected,
 * decides inserts, refreshes and status changes. Never resurrects completed or in-flight work.
 */
export function reconcile(input: {
  existing: ExistingOpportunity[];
  candidates: ScoredCandidate[];
  evaluated: Set<SignalFamily>;
  candidateFamily: (c: ScoredCandidate) => SignalFamily;
  now: Date;
  cfg: ScoringConfig;
}): ReconcilePlan {
  const { existing, candidates, now, cfg } = input;
  const byFp = new Map(existing.map((e) => [e.fingerprint, e]));
  const seen = new Set<string>();
  const plan: ReconcilePlan = { inserts: [], refreshes: [], missed: [] };

  for (const c of candidates) {
    if (seen.has(c.fingerprint)) continue; // two rules produced the same thing; first wins
    seen.add(c.fingerprint);
    const e = byFp.get(c.fingerprint);
    if (!e) {
      plan.inserts.push(c);
      continue;
    }
    const evidenceChanged = e.evidenceHash !== c.evidenceHash;
    switch (e.status) {
      case "candidate":
      case "reserve":
      case "recommended":
        plan.refreshes.push({ id: e.id, candidate: c, evidenceChanged });
        break;
      case "stale":
        plan.refreshes.push({ id: e.id, candidate: c, status: "candidate", evidenceChanged });
        break;
      case "deferred": {
        const due = !e.deferredUntil || e.deferredUntil <= now;
        plan.refreshes.push({ id: e.id, candidate: c, status: due ? "candidate" : undefined, evidenceChanged });
        break;
      }
      case "declined": {
        const withinWindow = e.decidedAt && now.getTime() - e.decidedAt.getTime() < cfg.declineSuppressDays * 86400_000;
        const material = evidenceChanged && c.priorityScore >= (e.scoreAtDecision ?? e.priorityScore) + cfg.declineReopenScoreJump;
        const reopen = !withinWindow || material || c.severity === "critical";
        plan.refreshes.push({ id: e.id, candidate: c, status: reopen ? "candidate" : undefined, evidenceChanged });
        break;
      }
      default:
        // approved / executing / completed: leave alone. A genuinely different opportunity has a
        // different action key, so it gets its own fingerprint.
        break;
    }
  }

  for (const e of existing) {
    if (seen.has(e.fingerprint) || !ACTIVE.has(e.status)) continue;
    // Only count a miss if the rule family that produced it actually ran this scan.
    if (!e.family || !input.evaluated.has(e.family)) continue;
    const missedScans = e.missedScans + 1;
    plan.missed.push({ id: e.id, missedScans, status: missedScans >= cfg.staleAfterMissedScans ? "stale" : undefined });
  }
  return plan;
}
