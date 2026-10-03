-- Defaults a fresh database needs before the operator's first login (BUILD_SPEC §7.8).
-- Idempotent: never overwrites values the operator has edited.
INSERT INTO "workspace" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "tiers" ("name", "posts_per_month", "scan_frequency", "price_pence", "sort_order") VALUES
  ('Starter', 2, 'monthly', 45000, 1),
  ('Growth', 4, 'fortnightly', 90000, 2),
  ('Pro', 8, 'weekly', 180000, 3)
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint
INSERT INTO "integrations" ("provider") VALUES ('siteguru'), ('github'), ('gbp'), ('serp'), ('anthropic'), ('slack')
ON CONFLICT ("provider") DO NOTHING;
