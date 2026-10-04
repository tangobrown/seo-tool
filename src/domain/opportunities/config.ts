/**
 * Scoring and selection config. Stored in workspace.scoring (the DB is the source of truth);
 * DEFAULT_SCORING is what a fresh workspace starts with and what missing keys fall back to.
 */
export type ScoringConfig = {
  /** score = 100 * (log10(raw) + offset) / range, clamped 0–100, where raw = impact×value×confidence×relevance / (effort×risk) */
  normaliser: { offset: number; range: number };
  thresholds: { high: number; medium: number };
  relevance: { base: number; priorityService: number; clientKeyword: number };
  /** Category weights (preferences, not quotas). Keys match WEIGHT_BUCKET values. */
  weights: Record<WeightBucket, number>;
  /** How many points a weight of 100 is worth when ordering (tie-break strength). */
  weightInfluence: number;
  /** Points subtracted per already-selected item in the same bucket, to shape the mix. */
  diversityPenalty: number;
  newPagesPerMonth: number;
  declineSuppressDays: number;
  declineReopenScoreJump: number;
  staleAfterMissedScans: number;
};

export type WeightBucket = "technical" | "existing_pages" | "new_pages" | "local" | "content" | "internal_links" | "links";

export const DEFAULT_SCORING: ScoringConfig = {
  normaliser: { offset: 1, range: 3.5 },
  thresholds: { high: 80, medium: 65 },
  relevance: { base: 1, priorityService: 0.3, clientKeyword: 0.2 },
  weights: { technical: 25, existing_pages: 20, new_pages: 20, local: 15, content: 10, internal_links: 5, links: 5 },
  weightInfluence: 5,
  diversityPenalty: 2,
  newPagesPerMonth: 6,
  declineSuppressDays: 90,
  declineReopenScoreJump: 15,
  staleAfterMissedScans: 2,
};

export function resolveScoring(stored: Partial<ScoringConfig> | null | undefined): ScoringConfig {
  return { ...DEFAULT_SCORING, ...(stored ?? {}), weights: { ...DEFAULT_SCORING.weights, ...(stored?.weights ?? {}) } };
}
