CREATE TABLE "siteguru_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signals" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "action_key" text;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "severity" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "missed_scans" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "score_at_decision" real;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "text_source" text DEFAULT 'template' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "scoring" jsonb;--> statement-breakpoint
ALTER TABLE "siteguru_signals" ADD CONSTRAINT "siteguru_signals_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "siteguru_signals_client_idx" ON "siteguru_signals" USING btree ("client_id","captured_at");--> statement-breakpoint
-- Default scoring config lives in the DB from the start (§10.5: configurable, never hard-coded).
UPDATE "workspace" SET "scoring" = '{"normaliser":{"offset":1,"range":3.5},"thresholds":{"high":80,"medium":65},"relevance":{"base":1,"priorityService":0.3,"clientKeyword":0.2},"weights":{"technical":25,"existing_pages":20,"new_pages":20,"local":15,"content":10,"internal_links":5,"links":5},"weightInfluence":5,"diversityPenalty":2,"newPagesPerMonth":6,"declineSuppressDays":90,"declineReopenScoreJump":15,"staleAfterMissedScans":2}'::jsonb WHERE "scoring" IS NULL;
