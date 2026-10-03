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
| 3–9 | Not started. The interfaces are in place (`src/integrations/types.ts`), and onboarding marks the SiteGuru, GBP and SERP steps as "skipped (Phase N)" |

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
cp .env.example .env              # then fill in SESSION_SECRET, ADMIN_*, ENCRYPTION_KEY
pnpm hash-password                # prints ADMIN_PASSWORD_HASH (use the \$-escaped line in .env)
pnpm db:migrate
pnpm db:seed                      # recreates the design mock's data (wipes the DB first)
pnpm dev                          # http://localhost:3000
pnpm inngest                      # in another terminal: Inngest dev server on :8288 (set INNGEST_DEV=1)
```

To watch the approval loop quickly, set Settings → General → Undo window to 15 seconds and `FAKE_EXECUTOR_SPEED=0.3`. Approve something, then open the Actioned tab: Queued (with countdown and Cancel batch) → Running → PR ready → Merged → Live.

Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test` (the approval test needs `DATABASE_URL`), `pnpm build`. After editing `templates/client-repo`, run `pnpm templates` (a test fails if the embedded copy is stale).

## Deploying (Vercel + Neon + Inngest)

1. Create a Neon project. Use the pooled string for `DATABASE_URL` and the direct one for `DATABASE_URL_UNPOOLED`.
2. Create a Vercel project (Pro plan, for longer function durations) from this repo. Set the build command to `pnpm vercel-build` so migrations run before each build.
3. Add the Inngest integration from the Vercel marketplace. It sets `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`, and the app serves functions at `/api/inngest`.
4. Set the remaining environment variables from `.env.example`. Paste `ADMIN_PASSWORD_HASH` **without** the `\$` escaping.
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
