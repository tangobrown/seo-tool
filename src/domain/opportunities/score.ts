import { evidenceHash, opportunityFingerprint } from "../fingerprint";
import type { ScoringConfig } from "./config";
import type { Candidate, DetectionInput, ScoredCandidate } from "./types";

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function mentions(text: string, term: string) {
  return text.toLowerCase().includes(term.toLowerCase());
}

/** Strategic relevance: boosted for priority services and the client's own target keywords. */
export function relevance(c: Candidate, client: DetectionInput["client"], cfg: ScoringConfig): number {
  const text = [c.targetQuery, c.service, c.title, c.targetUrl].filter(Boolean).join(" ");
  let r = cfg.relevance.base;
  if (client.priorityServices.some((s) => (c.service && c.service === s) || mentions(text, s))) r += cfg.relevance.priorityService;
  if (client.keywords.some((k) => mentions(text, k))) r += cfg.relevance.clientKeyword;
  return r;
}

/** §10.5: priority = impact × value × confidence × relevance / (effort × risk), normalised to 0–100. */
export function priorityScore(c: Candidate, rel: number, cfg: ScoringConfig): number {
  const f = (x: number) => clamp(x, 1, 10);
  const raw = (f(c.impact) * f(c.commercialValue) * f(c.confidence) * rel) / (f(c.effort) * f(c.risk));
  const score = (100 * (Math.log10(Math.max(raw, 1e-6)) + cfg.normaliser.offset)) / cfg.normaliser.range;
  return Math.round(clamp(score, 0, 100) * 10) / 10;
}

export function impactLabel(score: number, cfg: ScoringConfig): "high" | "medium" | "low" {
  return score >= cfg.thresholds.high ? "high" : score >= cfg.thresholds.medium ? "medium" : "low";
}

export function scoreCandidates(candidates: Candidate[], client: DetectionInput["client"], cfg: ScoringConfig): ScoredCandidate[] {
  return candidates.map((c) => {
    const priority = priorityScore(c, relevance(c, client, cfg), cfg);
    return {
      ...c,
      fingerprint: opportunityFingerprint({ clientId: client.id, type: c.type, targetUrl: c.targetUrl, targetQuery: c.targetQuery, actionKey: c.actionKey }),
      evidenceHash: evidenceHash(c.evidence),
      priorityScore: priority,
      impactLabel: impactLabel(priority, cfg),
    };
  });
}
