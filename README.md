# SEO Autopilot

Internal app for a UK SEO agency. One operator reviews evidence-backed SEO recommendations for each client, approves them in batches from their phone, and sends a monthly report. Approved website changes are made by Claude Code in the client's GitHub repo and arrive as a pull request.

- Product and technical spec: [`docs/BUILD_SPEC.md`](docs/BUILD_SPEC.md) (source of truth)
- Visual spec and prototype: [`docs/design/`](docs/design)
- Rules for Claude Code sessions: [`CLAUDE.md`](CLAUDE.md)

## Status

| Phase | State |
|---|---|
| 1. Foundation and UI shell | **Built.** Every §7 screen, auth with rate limiting, Drizzle schema, seed, audit log, attention items, Inngest wiring, batches with the undo window, FakeExecutor |
| 2. Onboarding and GitHub App | **Built, not yet tested against a real GitHub App or Anthropic key.** GitHub App provider (no SDK, `jose` + `fetch`), install callback, repo picker, `client.onboard`, setup PR, crawl, LLM classification and discovery, Confirm and activate. Client-repo workflow and QA script in [`templates/client-repo`](templates/client-repo) |
| 3. SiteGuru | **Built.** SiteGuru over its MCP server with an API key ([findings](docs/integrations/siteguru.md)), daily 05:00 sync, onboarding site matching, real KPIs/top pages/keywords, sync failures in Integrations and Needs attention. Integration keys can be pasted in Settings → Integrations |
| 4. Opportunity engine | **Built.** Deterministic rules over stored SiteGuru signals and the page inventory (`src/domain/opportunities/`), scoring config stored in the DB, fingerprint dedupe, 90-day decline suppression, defer resurfacing, stale after 2 missed scans, selection with critical-first and category weights, new-page cap, LLM wording with a number guard, auto-approve for alt text/schema/image compression, tier-cadence scheduling with one Slack message per run, "Run a scan now" |
| 5. Claude Code execution | **Built, not yet run against a real repo.** Approved batches dispatch the client repo's `seo-autopilot.yml` (one job per client at a time), the workflow fetches an HMAC-signed spec (fresh one-time callback token), sends signed and deduplicated callbacks, and opens one PR per batch. Merge → production check every 2 min for 30 min → Live. PR closed unmerged → back to Recommendations. QA failure → Failed + Retry (fresh batch and branch). Reconciliation every 10 min, 60-minute timeout. Contract test runs the template's real `callback.mjs` against the app. `EXECUTION_MODE=fake` keeps the simulator for demos |
| 8. Monthly reports and blog commitment | **Built, not yet run with a real Anthropic key.** `report.monthly` (1st, 07:00) writes one report per client for the previous month: numbers come from code (monthly snapshot, or the latest rolling 30 days labelled with its dates when the month isn't available), work = executions that went live in the London month, next = top backlog items. The LLM only rewords and falls back to the factual template if it adds a number or drops a decline. Email text and HTML, "Report ready" item, one Slack message. `blog.plan` (1st, 08:00, and on activation) plans N topics, each from a real SiteGuru query with impressions, and raises an item when there aren't enough instead of inventing any. `blog.draft_wave` (Mon 09:00) drafts posts spread over the month, quality-checks them (thin, stuffing, duplicates, testimonials, credentials, made-up figures, excluded areas) with one retry, then shows them as Content recommendations, or auto-approves them if "Review blog posts" is off. `blog.commitment_check` (daily) raises "X of N still to approve" in the final week. Manual: Reports tab → Generate now; client Settings → Plan blog posts now |
| 6, 7, 9 | Not started. Onboarding marks the GBP and SERP steps as "skipped (Phase N)"; GBP changes are manual checklists until Phase 6 |

## Stack

Next.js 16 (App Router; `src/proxy.ts` replaces `middleware.ts` in Next 16), Tailwind CSS 4 (tokens in `src/app/globals.css`), Drizzle + Neon Postgres, Inngest, Zod, `jose` sessions, argon2id.

```
src/
  app/            routes: (app)/ for authenticated screens, login/, api/
  components/     ui/ primitives + screen components
  db/             schema.ts, migrations/, seed.ts
  domain/         pure logic (fingerprinting, HTML extraction, report email, blog schedule) — no integration imports
  integrations/   anthropic/, github/, slack/, website/ + run.ts (timeouts, retries, health)
  jobs/           Inngest functions (batch dispatch + sweep, FakeExecutor, onboarding)
  lib/            auth, session, crypto, audit, attention, formatting
  server/         queries.ts, actions/ (every action checks the session), batches.ts, execution.ts
templates/client-repo/   workflow + QA script the setup PR adds to each client repo
```

## Local development

Requirements: Node 22+, pnpm 10, Postgres 16.

```bash
pnpm install
cp .env.example .env              # then fill in SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, ENCRYPTION_KEY
pnpm db:migrate
pnpm db:seed                      # recreates the design mock's data (wipes the DB first)
pnpm dev                          # http://localhost:3000
pnpm inngest                      # in another terminal: Inngest dev server on :8288 (set INNGEST_DEV=1)
```

To watch the approval loop quickly, set Settings → General → Undo window to 15 seconds and `FAKE_EXECUTOR_SPEED=0.3`. Approve something, then open the Actioned tab: Queued (with countdown and Cancel batch) → Running → PR ready → Merged → Live.

Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test` (the approval test needs `DATABASE_URL`), `pnpm build`. After editing `templates/client-repo`, run `pnpm templates` (a test fails if the embedded copy is stale).

## Deploying (Vercel + Neon + Inngest)

1. Create a Neon project. Use the pooled string for `DATABASE_URL` and the direct one for `DATABASE_URL_UNPOOLED`.
2. Create a Vercel project (Pro plan, for longer function durations) from this repo. `vercel.json` sets the build command to `pnpm vercel-build`, which runs migrations against `DATABASE_URL_UNPOOLED` before each build. The migrations also create the workspace row, the default tiers and the integration rows, so a fresh database works without seeding.
3. Add the Inngest integration from the Vercel marketplace. It sets `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`, and the app serves functions at `/api/inngest`.
4. Set the remaining environment variables from `.env.example`. For the login, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (or, optionally, `ADMIN_PASSWORD_HASH` from `pnpm hash-password`, pasted without the `\$` escaping).
5. Seed once if you want the demo data: `DATABASE_URL_UNPOOLED=… pnpm db:seed`. Skip this for a clean start; the workspace row and tiers can be created by running the seed and deleting the demo clients.

### GitHub App (Phase 2)

Create a GitHub App on the agency's organisation:

- **Permissions:** Contents (read/write), Pull requests (read/write), Actions (read/write), Workflows (read/write), Metadata (read).
- **Webhook URL:** `{APP_URL}/api/webhooks/github`, with a secret (`GITHUB_APP_WEBHOOK_SECRET`). Subscribe to *Pull request* and *Workflow run* events.
- **Setup URL:** `{APP_URL}/api/github/setup` (tick "Redirect on update").
- Generate a private key and set `GITHUB_APP_ID`, `GITHUB_APP_SLUG` and `GITHUB_APP_PRIVATE_KEY`.
- Install it on the client repos from Settings → Integrations.
- Add the organisation Actions secrets `ANTHROPIC_API_KEY` and `SEO_AUTOPILOT_CALLBACK_SECRET` (same value as `GITHUB_CALLBACK_SECRET`).
- Turn on "Allow GitHub Actions to create and approve pull requests" for the organisation. The workflow opens PRs with the workflow token.

Details of the client-repo workflow and how the Claude Code Action runs headless: [`docs/integrations/claude-code-action.md`](docs/integrations/claude-code-action.md).

**Before the first real batch**, for each client:
1. Merge the setup PR that onboarding opened. Until then, approved website changes fail with "Merge the SEO Autopilot setup PR", and Retry works once it's merged.
2. Check the org secret `SEO_AUTOPILOT_CALLBACK_SECRET` equals the app's `GITHUB_CALLBACK_SECRET`, and `APP_URL` is the public https URL of the app (the workflow fetches the spec from it).
3. If the client's build needs environment variables, add them to the workflow's Build step.

Known gaps:
- **PRs don't trigger the client repo's own CI.** The workflow opens them with `GITHUB_TOKEN`. Vercel previews still run.
- **Conflicts aren't detected automatically yet.** A PR that conflicts with an earlier unmerged one isn't marked Action needed; you'll see the conflict on GitHub.
