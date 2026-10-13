ALTER TYPE "public"."metric_source" ADD VALUE 'gsc' BEFORE 'gbp';--> statement-breakpoint
CREATE TABLE "site_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"provider" text DEFAULT 'dataforseo' NOT NULL,
	"task_id" text NOT NULL,
	"status" text DEFAULT 'crawling' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"pages_crawled" integer,
	"todo" jsonb,
	"summary" jsonb,
	"cost_usd" real,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "gsc_property" text;--> statement-breakpoint
ALTER TABLE "siteguru_signals" ADD COLUMN "source" text DEFAULT 'siteguru' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "serp_query_cap" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_audits" ADD CONSTRAINT "site_audits_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_audits_client_idx" ON "site_audits" USING btree ("client_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "site_audits_task_uq" ON "site_audits" USING btree ("task_id");--> statement-breakpoint
INSERT INTO "integrations" ("provider") VALUES ('gsc'), ('dataforseo'), ('pagespeed') ON CONFLICT DO NOTHING;
