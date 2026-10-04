# Opportunity engine (Phase 4)

How a scan turns data into recommendations. Spec: BUILD_SPEC §10.

```
client.scan:  sync SiteGuru KPIs → capture signals (stored in siteguru_signals) → detect → safety → score
              → reconcile (fingerprints, suppression, stale) → select → LLM wording → auto-approve
scan.schedule: hourly; acts at the workspace scan day/time (Europe/London); weekly / fortnightly (ISO-week parity of the
               client's start week) / monthly (first scan day); one Slack message per run
```

All decision logic is pure and lives in `src/domain/opportunities/`. It has no integration imports and is unit-tested in `test/engine.test.ts`.

## Detection rules (`detect.ts`)

| Signal | Rule | Type | Execution |
|---|---|---|---|
| SiteGuru to-do | sitemap, canonicals, broken links, internal redirects, page speed, alt text, structured data, OG tags, orphan pages. "No sitemap found" is critical. Vague to-dos (similar content, "get backlinks") are ignored. | technical_issue / schema / metadata / internal_linking | github_pr |
| SiteGuru to-do | indexation problems | technical_issue | **manual_action**: changing indexation is never automatic |
| Low-hanging fruit (90 days) | position 4–15 and ≥300 impressions, grouped per page | ranking_opportunity | github_pr |
| Declining content (6 months) | clicks down ≥20% from at least 30 a month | existing_page_optimisation | github_pr |
| Cannibalisation (90 days) | 2+ pages for a query with average position >3 (two pages already at the top isn't a problem) | existing_page_optimisation | github_pr |
| Top pages (30 days) | position 1–10, ≥1,000 impressions, CTR below 40% of typical for that position | ctr_improvement | github_pr |
| Page inventory | service or location pages with ≤1 internal link pointing in | internal_linking | github_pr |
| Page inventory | priority service with no dedicated page | new_service_page | github_pr |
| Page inventory + keywords | served location with no page **and** search demand (keywords naming it) | new_location_page | github_pr |

Every candidate carries evidence (`{source, metric, value, period, url, note}`); one without evidence is dropped. If a SiteGuru call fails, that family of rules is skipped for the scan, and it can't mark existing items as stale.

## Scoring (`score.ts`, config in `workspace.scoring`)

`raw = impact × commercial value × confidence × relevance ÷ (effort × risk)`, then `score = 100 × (log10(raw) + 1) ÷ 3.5`, clamped to 0–100. Relevance is boosted +0.3 for priority services and +0.2 for the client's target keywords. Labels: High ≥ 80, Medium ≥ 65. All of these values are editable in the DB config.

## Dedupe and suppression (`reconcile.ts`)

- `fingerprint = sha256(client | type | normalised URL | normalised query | action key)`. A match updates the existing row; it never inserts a new one.
- **Declined:** suppressed for 90 days unless the evidence changed **and** the score rose by ≥15 since the decline, or the issue is critical.
- **Deferred:** back in the pool after `deferred_until`.
- **Approved, executing or completed:** never touched.
- **Not detected in 2 scans** (by a rule that ran): stale.
- **LLM text:** kept until the evidence changes, then re-drafted.

## Selection (`select.ts`)

1. Strategy guards drop anything involving excluded services or locations, and new pages for services or locations not on the client's lists.
2. Critical items always come first.
3. Recommendations still awaiting review keep their place, and the list fills up to `recs_per_scan`.
4. Ordering is score + weight nudge − a repetition penalty. Weights are preferences, not quotas.
5. Never padded: anything below `min_score` stays a candidate. The rest of the qualifying items go to reserve.
6. New pages are capped at 6 per client per month. Blog posts are excluded; they belong to the Phase 8 commitment.

## Wording (`writeRecommendationText`)

The LLM rewrites the template text from the evidence (prompt `rec_text@1`, Zod-validated). If the rewrite contains any number not in the template or evidence, it's rejected and the factual template text is kept. If the LLM fails, a "Recommendation wording failed" attention item is raised and the template text stays.

## Not yet

- The page inventory is refreshed only at onboarding, not on every scan.
- GBP and SERP signals (Phases 6–7) and blog topics (Phase 8) will plug into `detect` as new families.
- Custom per-client weights are read when `weighting_mode = custom`; the UI for them is Phase 9.
