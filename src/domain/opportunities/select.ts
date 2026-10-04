import type { ScoringConfig } from "./config";
import { NEW_PAGE_TYPES, TYPE_BUCKET } from "./types";

export type PoolItem = {
  id: string;
  type: string;
  status: string;
  priorityScore: number;
  severity: string;
  guardViolation: string | null;
  isBlogCommitment: boolean;
};

export type Selection = { recommended: string[]; reserve: string[]; candidate: string[] };

/**
 * §10.5 selection. Pool = candidate/reserve/recommended items after this scan's reconcile.
 * Already-recommended items that still qualify keep their place (the operator may be mid-review);
 * the rest of the list fills up to recsPerScan. Never pads with low-value work.
 */
export function selectRecommendations(input: {
  pool: PoolItem[];
  cfg: ScoringConfig;
  recsPerScan: number;
  minScore: number;
  newPagesUsedThisMonth: number;
}): Selection {
  const { cfg } = input;
  const qualifies = (p: PoolItem) => !p.guardViolation && (p.severity === "critical" || p.priorityScore >= input.minScore);
  const pool = input.pool.filter((p) => !p.isBlogCommitment); // blog posts have their own commitment (§10.6)
  const qualifying = pool.filter(qualifies);
  const out: Selection = { recommended: [], reserve: [], candidate: pool.filter((p) => !qualifies(p)).map((p) => p.id) };

  let newPages = input.newPagesUsedThisMonth;
  const bucketCount = new Map<string, number>();
  const take = (p: PoolItem) => {
    out.recommended.push(p.id);
    const b = TYPE_BUCKET[p.type] ?? "technical";
    bucketCount.set(b, (bucketCount.get(b) ?? 0) + 1);
    if (NEW_PAGE_TYPES.has(p.type) && p.status !== "recommended") newPages++;
  };
  const allowedNewPage = (p: PoolItem) => !NEW_PAGE_TYPES.has(p.type) || p.status === "recommended" || newPages < cfg.newPagesPerMonth;

  // 1. Critical technical issues first, regardless of weighting.
  const critical = qualifying.filter((p) => p.severity === "critical").sort((a, b) => b.priorityScore - a.priorityScore);
  critical.forEach(take);

  // 2. Keep still-qualifying items the operator hasn't reviewed yet.
  const rest = qualifying.filter((p) => p.severity !== "critical");
  rest
    .filter((p) => p.status === "recommended")
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .forEach((p) => out.recommended.length < Math.max(input.recsPerScan, critical.length) && take(p));

  // 3. Fill the remaining slots greedily: score, nudged by category weight, damped by repetition.
  const remaining = rest.filter((p) => !out.recommended.includes(p.id));
  while (out.recommended.length < input.recsPerScan) {
    let best: PoolItem | null = null;
    let bestValue = -Infinity;
    for (const p of remaining) {
      if (out.recommended.includes(p.id) || !allowedNewPage(p)) continue;
      const bucket = TYPE_BUCKET[p.type] ?? "technical";
      const value =
        p.priorityScore + ((cfg.weights[bucket] ?? 0) / 100) * cfg.weightInfluence - (bucketCount.get(bucket) ?? 0) * cfg.diversityPenalty;
      if (value > bestValue) {
        bestValue = value;
        best = p;
      }
    }
    if (!best) break;
    take(best);
  }

  // 4. Everything else that qualifies waits in reserve (the backlog persists between scans).
  out.reserve = qualifying.filter((p) => !out.recommended.includes(p.id)).map((p) => p.id);
  return out;
}
