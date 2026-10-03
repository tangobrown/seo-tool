CREATE TYPE "public"."actor" AS ENUM('operator', 'system', 'claude_code', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."attention_kind" AS ENUM('pr_review', 'failed', 'manual_action', 'integration', 'confirm_client', 'blog_commitment', 'report_ready');--> statement-breakpoint
CREATE TYPE "public"."attention_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."batch_status" AS ENUM('pending_start', 'cancelled', 'running', 'awaiting_merge', 'completed', 'partially_failed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."category" AS ENUM('technical', 'on_page', 'content', 'links', 'local');--> statement-breakpoint
CREATE TYPE "public"."client_status" AS ENUM('onboarding', 'awaiting_confirmation', 'active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('connected', 'not_found', 'error', 'not_connected', 'pending');--> statement-breakpoint
CREATE TYPE "public"."execution_status" AS ENUM('queued', 'running', 'pr_ready', 'merged', 'live', 'failed', 'action_needed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."execution_type" AS ENUM('github_pr', 'gbp_api', 'content_generation', 'manual_action', 'outreach_draft');--> statement-breakpoint
CREATE TYPE "public"."gbp_change_status" AS ENUM('proposed', 'awaiting_approval', 'approved', 'submitted', 'verification_pending', 'verified', 'failed', 'manual_action_required');--> statement-breakpoint
CREATE TYPE "public"."impact_label" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."metric_source" AS ENUM('siteguru', 'gbp', 'serp');--> statement-breakpoint
CREATE TYPE "public"."opportunity_status" AS ENUM('candidate', 'recommended', 'reserve', 'approved', 'executing', 'completed', 'deferred', 'declined', 'stale');--> statement-breakpoint
CREATE TYPE "public"."page_type" AS ENUM('homepage', 'service', 'location', 'service_location', 'blog', 'about', 'contact', 'other');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('generated', 'read', 'sent');--> statement-breakpoint
CREATE TYPE "public"."risk_label" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."scan_frequency" AS ENUM('weekly', 'fortnightly', 'monthly');--> statement-breakpoint
CREATE SEQUENCE "public"."client_ref_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "attention_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"kind" "attention_kind" NOT NULL,
	"title" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"link" text,
	"meta" jsonb,
	"dedupe_key" text NOT NULL,
	"status" "attention_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "attention_items_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" "actor" NOT NULL,
	"client_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"event" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"kind" text NOT NULL,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"stats" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" text DEFAULT 'operator' NOT NULL,
	"status" "batch_status" DEFAULT 'pending_start' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batches_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "blog_commitments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"period" text NOT NULL,
	"committed" integer NOT NULL,
	"planned" integer DEFAULT 0 NOT NULL,
	"drafted" integer DEFAULT 0 NOT NULL,
	"approved" integer DEFAULT 0 NOT NULL,
	"published" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" "connection_status" DEFAULT 'pending' NOT NULL,
	"external_id" text,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref" text DEFAULT 'CLIENT-' || lpad(nextval('client_ref_seq')::text, 4, '0') NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"website_url" text NOT NULL,
	"status" "client_status" DEFAULT 'onboarding' NOT NULL,
	"tier_id" uuid NOT NULL,
	"contact_name" text DEFAULT '' NOT NULL,
	"contact_email" text DEFAULT '' NOT NULL,
	"industry" text DEFAULT '' NOT NULL,
	"primary_location" text DEFAULT '' NOT NULL,
	"brand_tone" text DEFAULT '' NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"services" text[] DEFAULT '{}'::text[] NOT NULL,
	"priority_services" text[] DEFAULT '{}'::text[] NOT NULL,
	"locations" text[] DEFAULT '{}'::text[] NOT NULL,
	"excluded_services" text[] DEFAULT '{}'::text[] NOT NULL,
	"excluded_locations" text[] DEFAULT '{}'::text[] NOT NULL,
	"auto_approve_low_impact" boolean DEFAULT false NOT NULL,
	"review_blog_posts" boolean DEFAULT true NOT NULL,
	"include_in_monthly_report" boolean DEFAULT true NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"weighting_mode" text,
	"weights" jsonb,
	"github_repo" text,
	"github_default_branch" text,
	"siteguru_site_id" text,
	"gbp_location_id" text,
	"onboarding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "clients_ref_unique" UNIQUE("ref")
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"execution_type" "execution_type" NOT NULL,
	"status" "execution_status" DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"error" text,
	"result" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "executions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "gbp_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_id" uuid,
	"client_id" uuid NOT NULL,
	"field" text NOT NULL,
	"before" jsonb,
	"proposed" jsonb,
	"after" jsonb,
	"api_response" jsonb,
	"status" "gbp_change_status" DEFAULT 'proposed' NOT NULL,
	"submitted_at" timestamp with time zone,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "github_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid,
	"client_id" uuid NOT NULL,
	"kind" text DEFAULT 'batch' NOT NULL,
	"repo" text NOT NULL,
	"branch" text NOT NULL,
	"workflow_run_id" text,
	"pr_number" integer,
	"pr_url" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"qa_results" jsonb,
	"callback_token_hash" text,
	"callback_token_expires_at" timestamp with time zone,
	"last_callback_at" timestamp with time zone,
	"merged_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"provider" text PRIMARY KEY NOT NULL,
	"status" "connection_status" DEFAULT 'not_connected' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_enc" text,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ip" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"success" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"source" "metric_source" NOT NULL,
	"kind" text DEFAULT 'rolling30' NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"metrics" jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monthly_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"period" text NOT NULL,
	"status" "report_status" DEFAULT 'generated' NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"summary" text NOT NULL,
	"sections" jsonb NOT NULL,
	"metrics" jsonb,
	"email_text" text DEFAULT '' NOT NULL,
	"email_html" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"account" text NOT NULL,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"type" text NOT NULL,
	"category" "category" NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"why" text DEFAULT '' NOT NULL,
	"proposed_action" text DEFAULT '' NOT NULL,
	"expected_benefit" text DEFAULT '' NOT NULL,
	"target_url" text,
	"target_query" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_hash" text,
	"impact" integer DEFAULT 5 NOT NULL,
	"commercial_value" integer DEFAULT 5 NOT NULL,
	"confidence" integer DEFAULT 5 NOT NULL,
	"effort" integer DEFAULT 5 NOT NULL,
	"risk" integer DEFAULT 3 NOT NULL,
	"priority_score" real DEFAULT 0 NOT NULL,
	"impact_label" "impact_label" DEFAULT 'medium' NOT NULL,
	"risk_label" "risk_label" DEFAULT 'low' NOT NULL,
	"execution_type" "execution_type" DEFAULT 'github_pr' NOT NULL,
	"status" "opportunity_status" DEFAULT 'candidate' NOT NULL,
	"status_note" text,
	"deferred_until" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by" "actor",
	"batch_id" uuid,
	"is_blog_commitment" boolean DEFAULT false NOT NULL,
	"payload" jsonb,
	"first_detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"times_recommended" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"baseline" real,
	"after_28d" real,
	"after_56d" real,
	"signal" text,
	"confidence" real
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"url" text NOT NULL,
	"path" text NOT NULL,
	"page_type" "page_type" DEFAULT 'other' NOT NULL,
	"service" text,
	"location" text,
	"commercial_intent" boolean DEFAULT false NOT NULL,
	"title" text,
	"h1" text,
	"canonical" text,
	"indexable" boolean DEFAULT true NOT NULL,
	"internal_links_in" integer DEFAULT 0 NOT NULL,
	"internal_links_out" integer DEFAULT 0 NOT NULL,
	"target_queries" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_crawled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "serp_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"query" text NOT NULL,
	"location" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"client_local_position" integer,
	"client_organic_position" integer,
	"local_pack" jsonb,
	"organic" jsonb
);
--> statement-breakpoint
CREATE TABLE "tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"posts_per_month" integer NOT NULL,
	"scan_frequency" "scan_frequency" NOT NULL,
	"price_pence" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "tiers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"delivery_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "webhook_events_delivery_id_unique" UNIQUE("delivery_id")
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"name" text DEFAULT 'SEO Autopilot' NOT NULL,
	"sender_name" text DEFAULT '' NOT NULL,
	"reply_to" text DEFAULT '' NOT NULL,
	"signoff" text DEFAULT '' NOT NULL,
	"undo_window_seconds" integer DEFAULT 120 NOT NULL,
	"recs_per_scan" integer DEFAULT 10 NOT NULL,
	"min_score" integer DEFAULT 65 NOT NULL,
	"scan_day" integer DEFAULT 1 NOT NULL,
	"scan_time" text DEFAULT '06:00' NOT NULL,
	"defer_days" integer DEFAULT 28 NOT NULL,
	"notifications" jsonb DEFAULT '{"newRecs":true,"reports":true,"weeklyDigest":false,"failures":true}'::jsonb NOT NULL,
	"slack_webhook_url_enc" text,
	"weighting_mode" text DEFAULT 'auto' NOT NULL,
	"weights" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blog_commitments" ADD CONSTRAINT "blog_commitments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_connections" ADD CONSTRAINT "client_connections_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_tier_id_tiers_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."tiers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gbp_changes" ADD CONSTRAINT "gbp_changes_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gbp_changes" ADD CONSTRAINT "gbp_changes_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_jobs" ADD CONSTRAINT "github_jobs_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_jobs" ADD CONSTRAINT "github_jobs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_snapshots" ADD CONSTRAINT "metric_snapshots_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_reports" ADD CONSTRAINT "monthly_reports_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_results" ADD CONSTRAINT "opportunity_results_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serp_snapshots" ADD CONSTRAINT "serp_snapshots_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attention_items_client_idx" ON "attention_items" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "attention_items_status_idx" ON "attention_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_log_client_idx" ON "audit_log" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "automation_runs_client_idx" ON "automation_runs" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "batches_client_idx" ON "batches" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "blog_commitments_client_idx" ON "blog_commitments" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "blog_commitments_client_period_uq" ON "blog_commitments" USING btree ("client_id","period");--> statement-breakpoint
CREATE INDEX "client_connections_client_idx" ON "client_connections" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "client_connections_client_provider_uq" ON "client_connections" USING btree ("client_id","provider");--> statement-breakpoint
CREATE INDEX "clients_status_idx" ON "clients" USING btree ("status");--> statement-breakpoint
CREATE INDEX "executions_batch_idx" ON "executions" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "executions_opportunity_idx" ON "executions" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "gbp_changes_client_idx" ON "gbp_changes" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "github_jobs_client_idx" ON "github_jobs" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "github_jobs_batch_idx" ON "github_jobs" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_at_idx" ON "login_attempts" USING btree ("ip","at");--> statement-breakpoint
CREATE INDEX "metric_snapshots_client_idx" ON "metric_snapshots" USING btree ("client_id","source","captured_at");--> statement-breakpoint
CREATE INDEX "monthly_reports_client_idx" ON "monthly_reports" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "monthly_reports_client_period_uq" ON "monthly_reports" USING btree ("client_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_tokens_provider_account_uq" ON "oauth_tokens" USING btree ("provider","account");--> statement-breakpoint
CREATE INDEX "opportunities_client_idx" ON "opportunities" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "opportunities_client_status_idx" ON "opportunities" USING btree ("client_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunities_client_fingerprint_uq" ON "opportunities" USING btree ("client_id","fingerprint");--> statement-breakpoint
CREATE INDEX "pages_client_idx" ON "pages" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pages_client_url_uq" ON "pages" USING btree ("client_id","url");--> statement-breakpoint
CREATE INDEX "serp_snapshots_client_idx" ON "serp_snapshots" USING btree ("client_id");