-- SiteGuru retired (13 Oct 2026): search data comes from Search Console, audits from DataForSEO.
-- Its past monthly figures stay in metric_snapshots as history; nothing else reads SiteGuru now.
DELETE FROM "client_connections" WHERE "provider" = 'siteguru';--> statement-breakpoint
UPDATE "integrations" SET "secret_enc" = NULL, "status" = 'not_connected', "last_error" = NULL WHERE "provider" = 'siteguru';--> statement-breakpoint
UPDATE "attention_items" SET "status" = 'resolved', "resolved_at" = now() WHERE "status" = 'open' AND "dedupe_key" LIKE 'siteguru%';
