# Search Console, DataForSEO and PageSpeed: findings (13 Oct 2026)

Sources: DataForSEO's official OpenAPI spec (github.com/dataforseo/OpenApiDocumentation), Google's live discovery documents for Search Console and PageSpeed Insights, and official help pages. The docs websites were blocked from the build environment, so anything not in those machine-readable specs is marked **unverified** below and must be checked on the first real run.

## Search Console
- Service account: JWT bearer exchange at `oauth2.googleapis.com/token`, scope `webmasters.readonly`. The client adds the service account's email under Search Console → Settings → Users and permissions. We ask for Restricted; **unverified** whether Restricted is enough for every query (Full certainly is).
- `searchAnalytics.query`: up to 25,000 rows per request (we page with `startRow`), 16 months of history, dates in Pacific time, `ctr` is a fraction, `rows` is missing when there's no data.
- Data lags about 2–3 days (**unverified figure**; the code finds the latest day with data instead of assuming).

## DataForSEO
- Basic auth with the API login and API password. POST bodies are arrays of tasks. Always check each task's `status_code`.
- **Not-ready codes are 40601/40602.** 40102 means "no results" and is still billed.
- Organic results: `device: mobile` because local-pack `rank_group` is documented as always 0 on desktop. Maps: billed per 100 results; we ask for 20.
- Towns are resolved to `location_code` from `/v3/serp/google/locations/gb` (type "City") and cached. A town Google doesn't list is skipped and reported, never guessed.
- On-Page: `summary` can be polled during the crawl; `extended_crawl_status` other than `no_errors` means the site wasn't crawled. The `checks` keys aren't enumerated in the spec, so problems are worked out from per-page fields (`meta.title`, `meta.description`, `meta.htags.h1`, `status_code`) plus the confirmed checks `no_image_alt`, `is_orphan_page`, `canonical_to_redirect`, and the links and non-indexable endpoints.
- **Unverified:** the `domain_info.checks.sitemap` key (from a 2023 sample; if absent, no sitemap item is raised), `/v3/appendix/user_data` balance field, rate limits, and whether `max_crawl_pages` cost is reserved then refunded.

## Cost (from DataForSEO's pricing pages; check before relying on it)
- Rankings: $0.0006 per search, standard queue. 30 searches × 2 (organic + Maps) × ~4 scans a month ≈ **$0.15 per client per month**.
- Site audit: $0.00015 per page, basic crawl. 500 pages × ~4 scans ≈ **$0.30 per client per month**.
- PageSpeed Insights and Search Console: free.
- Total ≈ **$0.45 (about 35p) per client per month** on a weekly cadence. Well under the spec's £20 flag.

## PageSpeed Insights
- `runPagespeed?strategy=mobile&category=performance`. Score is 0–1 (can be null); results with `lighthouseResult.runtimeError` are discarded. A key is optional.
