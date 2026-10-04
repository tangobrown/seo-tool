import type { EvidenceItem } from "@/db/schema";
import type { WeightBucket } from "./config";

export type Category = "technical" | "on_page" | "content" | "links" | "local";
export type ExecutionType = "github_pr" | "gbp_api" | "content_generation" | "manual_action" | "outreach_draft";

/** Everything detection needs, already fetched and stored. Detection never calls a provider. */
export type DetectionInput = {
  client: {
    id: string;
    domain: string;
    services: string[];
    priorityServices: string[];
    locations: string[];
    excludedServices: string[];
    excludedLocations: string[];
    keywords: string[];
  };
  pages: {
    path: string;
    pageType: string;
    service: string | null;
    location: string | null;
    title: string | null;
    h1: string | null;
    internalLinksIn: number;
  }[];
  signals: Signals;
};

export type Signals = {
  todo?: { checkName: string; severity: string; title: string; description?: string; affectedPages?: number | null; reportUrl?: string }[];
  /** Near-miss keywords over the last 90 days. */
  lowHangingFruit?: { keyword: string; path: string; clicks: number; impressions: number; avgPosition: number }[];
  /** Pages losing clicks over the last 6 complete months. */
  declining?: { path: string; percentChange: number; netChange: number; oldestClicks: number; newestClicks: number; fromMonth: string; toMonth: string }[];
  cannibalization?: { keyword: string; impressions: number; avgPosition: number | null; pages: { path: string; clicks: number; avgPosition: number | null }[] }[];
  /** Top pages over the last 30 days. */
  topPages?: { path: string; clicks: number; impressions: number; avgPosition: number }[];
  /** Top keywords over the last 30 days, for demand evidence. */
  keywords?: { keyword: string; clicks: number; impressions: number; position: number | null }[];
};

/** Which signal families were fetched this scan. Only these can mark existing items as missed. */
export type SignalFamily = "todo" | "lowHangingFruit" | "declining" | "cannibalization" | "topPages" | "pages";

export type Candidate = {
  type: string;
  category: Category;
  family: SignalFamily;
  actionKey: string;
  targetUrl: string | null;
  targetQuery: string | null;
  title: string;
  description: string;
  why: string;
  proposedAction: string;
  expectedBenefit: string;
  evidence: EvidenceItem[];
  impact: number;
  commercialValue: number;
  confidence: number;
  effort: number;
  risk: number;
  executionType: ExecutionType;
  riskLabel: "low" | "medium" | "high";
  severity: "critical" | "normal";
  service?: string | null;
  location?: string | null;
  newPage?: boolean;
  /** Eligible for "Auto-approve low-impact fixes" (alt text, schema, image compression only). */
  autoApproveKind?: "alt_text" | "schema" | "image_compression";
};

export type ScoredCandidate = Candidate & { fingerprint: string; evidenceHash: string; priorityScore: number; impactLabel: "high" | "medium" | "low" };

export const TYPE_BUCKET: Record<string, WeightBucket> = {
  technical_issue: "technical",
  schema: "technical",
  existing_page_optimisation: "existing_pages",
  metadata: "existing_pages",
  ctr_improvement: "existing_pages",
  ranking_opportunity: "existing_pages",
  cro_improvement: "existing_pages",
  internal_linking: "internal_links",
  new_service_page: "new_pages",
  new_location_page: "new_pages",
  content_gap: "content",
  blog_content: "content",
  competitor_gap: "content",
  link_opportunity: "links",
  gbp_improvement: "local",
  local_visibility: "local",
  review_opportunity: "local",
};

export const NEW_PAGE_TYPES = new Set(["new_service_page", "new_location_page"]);

/** Which signal family produced an opportunity, from its action key (for stale tracking). */
export function familyOf(actionKey: string | null): SignalFamily | null {
  if (!actionKey) return null;
  if (actionKey === "rank") return "lowHangingFruit";
  if (actionKey === "refresh") return "declining";
  if (actionKey === "cannibalisation") return "cannibalization";
  if (actionKey === "ctr") return "topPages";
  if (actionKey === "links_in" || actionKey.startsWith("service:") || actionKey.startsWith("location:")) return "pages";
  if (["sitemap", "indexability", "canonicals", "broken_links", "internal_redirects", "page_speed", "alt_text", "schema", "og_tags", "orphans"].includes(actionKey)) return "todo";
  return null;
}
