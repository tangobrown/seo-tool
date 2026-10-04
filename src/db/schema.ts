import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSequence,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ScoringConfig } from "@/domain/opportunities/config";

const id = () => uuid("id").primaryKey().defaultRandom();
const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts("created_at").notNull().defaultNow();

// ── Enums ────────────────────────────────────────────────────────────────

export const scanFrequency = pgEnum("scan_frequency", ["weekly", "fortnightly", "monthly"]);
export const clientStatus = pgEnum("client_status", [
  "onboarding",
  "awaiting_confirmation",
  "active",
  "paused",
  "archived",
]);
export const category = pgEnum("category", ["technical", "on_page", "content", "links", "local"]);
export const impactLabel = pgEnum("impact_label", ["high", "medium", "low"]);
export const riskLabel = pgEnum("risk_label", ["low", "medium", "high"]);
export const executionType = pgEnum("execution_type", [
  "github_pr",
  "gbp_api",
  "content_generation",
  "manual_action",
  "outreach_draft",
]);
export const opportunityStatus = pgEnum("opportunity_status", [
  "candidate",
  "recommended",
  "reserve",
  "approved",
  "executing",
  "completed",
  "deferred",
  "declined",
  "stale",
]);
export const batchStatus = pgEnum("batch_status", [
  "pending_start",
  "cancelled",
  "running",
  "awaiting_merge",
  "completed",
  "partially_failed",
  "failed",
]);
export const executionStatus = pgEnum("execution_status", [
  "queued",
  "running",
  "pr_ready",
  "merged",
  "live",
  "failed",
  "action_needed",
  "cancelled",
]);
export const actor = pgEnum("actor", ["operator", "system", "claude_code", "webhook"]);
export const attentionStatus = pgEnum("attention_status", ["open", "resolved"]);
export const attentionKind = pgEnum("attention_kind", [
  "pr_review",
  "failed",
  "manual_action",
  "integration",
  "confirm_client",
  "blog_commitment",
  "report_ready",
]);
export const reportStatus = pgEnum("report_status", ["generated", "read", "sent"]);
export const connectionStatus = pgEnum("connection_status", [
  "connected",
  "not_found",
  "error",
  "not_connected",
  "pending",
]);
export const gbpChangeStatus = pgEnum("gbp_change_status", [
  "proposed",
  "awaiting_approval",
  "approved",
  "submitted",
  "verification_pending",
  "verified",
  "failed",
  "manual_action_required",
]);
export const metricSource = pgEnum("metric_source", ["siteguru", "gbp", "serp"]);
export const pageType = pgEnum("page_type", [
  "homepage",
  "service",
  "location",
  "service_location",
  "blog",
  "about",
  "contact",
  "other",
]);
export const runStatus = pgEnum("run_status", ["running", "succeeded", "failed"]);

export const clientRefSeq = pgSequence("client_ref_seq", { startWith: 1 });

// ── Workspace ────────────────────────────────────────────────────────────

export type NotificationPrefs = {
  newRecs: boolean;
  reports: boolean;
  weeklyDigest: boolean;
  failures: boolean;
};

export const workspace = pgTable("workspace", {
  id: integer("id").primaryKey().default(1),
  name: text("name").notNull().default("SEO Autopilot"),
  senderName: text("sender_name").notNull().default(""),
  replyTo: text("reply_to").notNull().default(""),
  signoff: text("signoff").notNull().default(""),
  undoWindowSeconds: integer("undo_window_seconds").notNull().default(120),
  recsPerScan: integer("recs_per_scan").notNull().default(10),
  minScore: integer("min_score").notNull().default(65),
  scanDay: integer("scan_day").notNull().default(1), // ISO weekday, 1 = Monday
  scanTime: text("scan_time").notNull().default("06:00"),
  deferDays: integer("defer_days").notNull().default(28),
  notifications: jsonb("notifications")
    .$type<NotificationPrefs>()
    .notNull()
    .default({ newRecs: true, reports: true, weeklyDigest: false, failures: true }),
  slackWebhookUrlEnc: text("slack_webhook_url_enc"),
  weightingMode: text("weighting_mode").notNull().default("auto"),
  weights: jsonb("weights").$type<Record<string, number>>(),
  /** Scoring config (§10.5). Null keys fall back to DEFAULT_SCORING in domain/opportunities/config.ts. */
  scoring: jsonb("scoring").$type<Partial<ScoringConfig>>(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const tiers = pgTable("tiers", {
  id: id(),
  name: text("name").notNull().unique(),
  postsPerMonth: integer("posts_per_month").notNull(),
  scanFrequency: scanFrequency("scan_frequency").notNull(),
  pricePence: integer("price_pence").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

// ── Clients ──────────────────────────────────────────────────────────────

export type OnboardingStep = {
  status: "pending" | "running" | "ok" | "failed" | "skipped";
  at?: string;
  message?: string;
  data?: Record<string, unknown>;
};
export type OnboardingState = Record<string, OnboardingStep>;

export const clients = pgTable(
  "clients",
  {
    id: id(),
    ref: text("ref")
      .notNull()
      .unique()
      .default(sql`'CLIENT-' || lpad(nextval('client_ref_seq')::text, 4, '0')`),
    name: text("name").notNull(),
    domain: text("domain").notNull(),
    websiteUrl: text("website_url").notNull(),
    status: clientStatus("status").notNull().default("onboarding"),
    tierId: uuid("tier_id")
      .notNull()
      .references(() => tiers.id),
    contactName: text("contact_name").notNull().default(""),
    contactEmail: text("contact_email").notNull().default(""),
    industry: text("industry").notNull().default(""),
    primaryLocation: text("primary_location").notNull().default(""),
    brandTone: text("brand_tone").notNull().default(""),
    keywords: text("keywords").array().notNull().default(sql`'{}'::text[]`),
    services: text("services").array().notNull().default(sql`'{}'::text[]`),
    priorityServices: text("priority_services").array().notNull().default(sql`'{}'::text[]`),
    locations: text("locations").array().notNull().default(sql`'{}'::text[]`),
    excludedServices: text("excluded_services").array().notNull().default(sql`'{}'::text[]`),
    excludedLocations: text("excluded_locations").array().notNull().default(sql`'{}'::text[]`),
    autoApproveLowImpact: boolean("auto_approve_low_impact").notNull().default(false),
    reviewBlogPosts: boolean("review_blog_posts").notNull().default(true),
    includeInMonthlyReport: boolean("include_in_monthly_report").notNull().default(true),
    paused: boolean("paused").notNull().default(false),
    weightingMode: text("weighting_mode"),
    weights: jsonb("weights").$type<Record<string, number>>(),
    githubRepo: text("github_repo"),
    githubDefaultBranch: text("github_default_branch"),
    siteguruSiteId: text("siteguru_site_id"),
    gbpLocationId: text("gbp_location_id"),
    onboarding: jsonb("onboarding").$type<OnboardingState>().notNull().default({}),
    createdAt: createdAt(),
    archivedAt: ts("archived_at"),
  },
  (t) => [index("clients_status_idx").on(t.status)],
);

// ── Integrations & connections ───────────────────────────────────────────

export const integrations = pgTable("integrations", {
  provider: text("provider").primaryKey(),
  status: connectionStatus("status").notNull().default("not_connected"),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  secretEnc: text("secret_enc"),
  lastSuccessAt: ts("last_success_at"),
  lastFailureAt: ts("last_failure_at"),
  lastError: text("last_error"),
});

export const clientConnections = pgTable(
  "client_connections",
  {
    id: id(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    provider: text("provider").notNull(), // website | github | siteguru | gbp
    status: connectionStatus("status").notNull().default("pending"),
    externalId: text("external_id"),
    lastSuccessAt: ts("last_success_at"),
    lastFailureAt: ts("last_failure_at"),
    lastError: text("last_error"),
  },
  (t) => [
    index("client_connections_client_idx").on(t.clientId),
    uniqueIndex("client_connections_client_provider_uq").on(t.clientId, t.provider),
  ],
);

export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: id(),
    provider: text("provider").notNull(),
    account: text("account").notNull(),
    accessTokenEnc: text("access_token_enc").notNull(),
    refreshTokenEnc: text("refresh_token_enc"),
    expiresAt: ts("expires_at"),
  },
  (t) => [uniqueIndex("oauth_tokens_provider_account_uq").on(t.provider, t.account)],
);

// ── Pages ────────────────────────────────────────────────────────────────

export const pages = pgTable(
  "pages",
  {
    id: id(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    url: text("url").notNull(),
    path: text("path").notNull(),
    pageType: pageType("page_type").notNull().default("other"),
    service: text("service"),
    location: text("location"),
    commercialIntent: boolean("commercial_intent").notNull().default(false),
    title: text("title"),
    h1: text("h1"),
    canonical: text("canonical"),
    indexable: boolean("indexable").notNull().default(true),
    internalLinksIn: integer("internal_links_in").notNull().default(0),
    internalLinksOut: integer("internal_links_out").notNull().default(0),
    targetQueries: text("target_queries").array().notNull().default(sql`'{}'::text[]`),
    lastCrawledAt: ts("last_crawled_at"),
  },
  (t) => [
    index("pages_client_idx").on(t.clientId),
    uniqueIndex("pages_client_url_uq").on(t.clientId, t.url),
  ],
);

// ── Opportunities ────────────────────────────────────────────────────────

export type EvidenceItem = {
  source: "siteguru" | "gbp" | "serp" | "crawl";
  metric: string;
  value: string | number;
  period?: string;
  url?: string;
  note?: string;
};

export const opportunities = pgTable(
  "opportunities",
  {
    id: id(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    fingerprint: text("fingerprint").notNull(),
    type: text("type").notNull(),
    category: category("category").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    why: text("why").notNull().default(""),
    proposedAction: text("proposed_action").notNull().default(""),
    expectedBenefit: text("expected_benefit").notNull().default(""),
    targetUrl: text("target_url"),
    targetQuery: text("target_query"),
    evidence: jsonb("evidence").$type<EvidenceItem[]>().notNull().default([]),
    evidenceHash: text("evidence_hash"),
    impact: integer("impact").notNull().default(5),
    commercialValue: integer("commercial_value").notNull().default(5),
    confidence: integer("confidence").notNull().default(5),
    effort: integer("effort").notNull().default(5),
    risk: integer("risk").notNull().default(3),
    priorityScore: real("priority_score").notNull().default(0),
    impactLabel: impactLabel("impact_label").notNull().default("medium"),
    riskLabel: riskLabel("risk_label").notNull().default("low"),
    executionType: executionType("execution_type").notNull().default("github_pr"),
    status: opportunityStatus("status").notNull().default("candidate"),
    statusNote: text("status_note"),
    deferredUntil: ts("deferred_until"),
    decidedAt: ts("decided_at"),
    decidedBy: actor("decided_by"),
    batchId: uuid("batch_id"),
    isBlogCommitment: boolean("is_blog_commitment").notNull().default(false),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    firstDetectedAt: ts("first_detected_at").notNull().defaultNow(),
    lastDetectedAt: ts("last_detected_at").notNull().defaultNow(),
    timesRecommended: integer("times_recommended").notNull().default(0),
    actionKey: text("action_key"),
    /** "critical" bypasses weighting and always appears first (§10.5). */
    severity: text("severity").notNull().default("normal"),
    /** Consecutive scans this candidate wasn't detected in; 2 → stale. */
    missedScans: integer("missed_scans").notNull().default(0),
    /** Priority score when the operator declined it, for the "rises by 15" reopen rule. */
    scoreAtDecision: real("score_at_decision"),
    /** "template" (rule text) or "llm" (rewritten from evidence; prompt version in payload). */
    textSource: text("text_source").notNull().default("template"),
  },
  (t) => [
    index("opportunities_client_idx").on(t.clientId),
    index("opportunities_client_status_idx").on(t.clientId, t.status),
    uniqueIndex("opportunities_client_fingerprint_uq").on(t.clientId, t.fingerprint),
  ],
);

// ── Execution ────────────────────────────────────────────────────────────

export const batches = pgTable(
  "batches",
  {
    id: id(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdBy: text("created_by").notNull().default("operator"), // operator | auto
    status: batchStatus("status").notNull().default("pending_start"),
    startsAt: ts("starts_at").notNull(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
  },
  (t) => [index("batches_client_idx").on(t.clientId)],
);

export const executions = pgTable(
  "executions",
  {
    id: id(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => batches.id),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id),
    executionType: executionType("execution_type").notNull(),
    status: executionStatus("status").notNull().default("queued"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    attempt: integer("attempt").notNull().default(1),
    error: text("error"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    index("executions_batch_idx").on(t.batchId),
    index("executions_opportunity_idx").on(t.opportunityId),
  ],
);

export const githubJobs = pgTable(
  "github_jobs",
  {
    id: id(),
    batchId: uuid("batch_id").references(() => batches.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    kind: text("kind").notNull().default("batch"), // batch | setup
    repo: text("repo").notNull(),
    branch: text("branch").notNull(),
    workflowRunId: text("workflow_run_id"),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    status: text("status").notNull().default("queued"),
    qaResults: jsonb("qa_results").$type<Record<string, unknown>>(),
    callbackTokenHash: text("callback_token_hash"),
    callbackTokenExpiresAt: ts("callback_token_expires_at"),
    lastCallbackAt: ts("last_callback_at"),
    mergedAt: ts("merged_at"),
    verifiedAt: ts("verified_at"),
    createdAt: createdAt(),
  },
  (t) => [index("github_jobs_client_idx").on(t.clientId), index("github_jobs_batch_idx").on(t.batchId)],
);

export const gbpChanges = pgTable(
  "gbp_changes",
  {
    id: id(),
    executionId: uuid("execution_id").references(() => executions.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    field: text("field").notNull(),
    before: jsonb("before"),
    proposed: jsonb("proposed"),
    after: jsonb("after"),
    apiResponse: jsonb("api_response"),
    status: gbpChangeStatus("status").notNull().default("proposed"),
    submittedAt: ts("submitted_at"),
    verifiedAt: ts("verified_at"),
  },
  (t) => [index("gbp_changes_client_idx").on(t.clientId)],
);

// ── Metrics ──────────────────────────────────────────────────────────────

export type SiteMetrics = {
  clicks?: number | null;
  impressions?: number | null;
  avgPosition?: number | null;
  ctr?: number | null;
  prev?: { clicks?: number | null; impressions?: number | null; avgPosition?: number | null; ctr?: number | null };
  topPages?: { path: string; clicks: number }[];
  topKeywords?: { keyword: string; position: number; change: number | null }[];
};

export const metricSnapshots = pgTable(
  "metric_snapshots",
  {
    id: id(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    source: metricSource("source").notNull(),
    kind: text("kind").notNull().default("rolling30"), // rolling30 | month
    periodStart: ts("period_start").notNull(),
    periodEnd: ts("period_end").notNull(),
    metrics: jsonb("metrics").$type<SiteMetrics>().notNull(),
    capturedAt: ts("captured_at").notNull().defaultNow(),
  },
  (t) => [
    index("metric_snapshots_client_idx").on(t.clientId, t.source, t.capturedAt),
    // One snapshot per calendar month per source; rolling30 rows accumulate (one per sync day).
    uniqueIndex("metric_snapshots_month_uq").on(t.clientId, t.source, t.kind, t.periodStart).where(sql`kind = 'month'`),
  ],
);

export const serpSnapshots = pgTable(
  "serp_snapshots",
  {
    id: id(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    query: text("query").notNull(),
    location: text("location").notNull(),
    capturedAt: ts("captured_at").notNull().defaultNow(),
    clientLocalPosition: integer("client_local_position"),
    clientOrganicPosition: integer("client_organic_position"),
    localPack: jsonb("local_pack"),
    organic: jsonb("organic"),
  },
  (t) => [index("serp_snapshots_client_idx").on(t.clientId)],
);

// ── Blog & reports ───────────────────────────────────────────────────────

export const blogCommitments = pgTable(
  "blog_commitments",
  {
    id: id(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    period: text("period").notNull(),
    committed: integer("committed").notNull(),
    planned: integer("planned").notNull().default(0),
    drafted: integer("drafted").notNull().default(0),
    approved: integer("approved").notNull().default(0),
    published: integer("published").notNull().default(0),
  },
  (t) => [
    index("blog_commitments_client_idx").on(t.clientId),
    uniqueIndex("blog_commitments_client_period_uq").on(t.clientId, t.period),
  ],
);

export type ReportSection = { title: string; items: string[] };

export const monthlyReports = pgTable(
  "monthly_reports",
  {
    id: id(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    period: text("period").notNull(),
    status: reportStatus("status").notNull().default("generated"),
    generatedAt: ts("generated_at").notNull().defaultNow(),
    readAt: ts("read_at"),
    sentAt: ts("sent_at"),
    summary: text("summary").notNull(),
    sections: jsonb("sections").$type<ReportSection[]>().notNull(),
    metrics: jsonb("metrics").$type<Record<string, unknown>>(),
    emailText: text("email_text").notNull().default(""),
    emailHtml: text("email_html").notNull().default(""),
  },
  (t) => [
    index("monthly_reports_client_idx").on(t.clientId),
    uniqueIndex("monthly_reports_client_period_uq").on(t.clientId, t.period),
  ],
);

// ── Operations ───────────────────────────────────────────────────────────

export const attentionItems = pgTable(
  "attention_items",
  {
    id: id(),
    clientId: uuid("client_id").references(() => clients.id),
    kind: attentionKind("kind").notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull().default(""),
    link: text("link"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    dedupeKey: text("dedupe_key").notNull().unique(),
    status: attentionStatus("status").notNull().default("open"),
    createdAt: createdAt(),
    resolvedAt: ts("resolved_at"),
  },
  (t) => [index("attention_items_client_idx").on(t.clientId), index("attention_items_status_idx").on(t.status)],
);

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: id(),
    clientId: uuid("client_id").references(() => clients.id),
    kind: text("kind").notNull(),
    status: runStatus("status").notNull().default("running"),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    stats: jsonb("stats").$type<Record<string, unknown>>(),
    error: text("error"),
  },
  (t) => [index("automation_runs_client_idx").on(t.clientId)],
);

export const webhookEvents = pgTable("webhook_events", {
  id: id(),
  provider: text("provider").notNull(),
  deliveryId: text("delivery_id").notNull().unique(),
  receivedAt: ts("received_at").notNull().defaultNow(),
  processedAt: ts("processed_at"),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    at: ts("at").notNull().defaultNow(),
    actor: actor("actor").notNull(),
    clientId: uuid("client_id").references(() => clients.id),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    event: text("event").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    meta: jsonb("meta"),
  },
  (t) => [index("audit_log_at_idx").on(t.at), index("audit_log_client_idx").on(t.clientId)],
);

export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: id(),
    ip: text("ip").notNull(),
    at: ts("at").notNull().defaultNow(),
    success: boolean("success").notNull(),
  },
  (t) => [index("login_attempts_ip_at_idx").on(t.ip, t.at)],
);

export const opportunityResults = pgTable("opportunity_results", {
  id: id(),
  opportunityId: uuid("opportunity_id")
    .notNull()
    .references(() => opportunities.id),
  metric: text("metric").notNull(),
  baseline: real("baseline"),
  after28d: real("after_28d"),
  after56d: real("after_56d"),
  signal: text("signal"),
  confidence: real("confidence"),
});

export type Client = typeof clients.$inferSelect;
export type Tier = typeof tiers.$inferSelect;
export type Opportunity = typeof opportunities.$inferSelect;
export type Batch = typeof batches.$inferSelect;
export type Execution = typeof executions.$inferSelect;
export type Workspace = typeof workspace.$inferSelect;
export type AttentionItem = typeof attentionItems.$inferSelect;
export type MonthlyReport = typeof monthlyReports.$inferSelect;
export type Integration = typeof integrations.$inferSelect;
export type ClientConnection = typeof clientConnections.$inferSelect;

/** Raw SiteGuru detection inputs captured at each scan. Detection reads these, never live calls. */
export const siteguruSignals = pgTable(
  "siteguru_signals",
  {
    id: id(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    capturedAt: ts("captured_at").notNull().defaultNow(),
    signals: jsonb("signals").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [index("siteguru_signals_client_idx").on(t.clientId, t.capturedAt)],
);
