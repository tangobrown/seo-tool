# SEO Autopilot — Claude Code instructions

Internal tool for a UK SEO agency. One operator (the agency owner) uses it, mostly from a phone, to review SEO recommendations for small-business clients, approve them in batches, and send monthly reports. Approved website work is implemented by Claude Code in each client's GitHub repo and delivered as a pull request.

**Read these before writing code:**
1. `docs/BUILD_SPEC.md` — the full product and technical spec. It is the source of truth.
2. `docs/design/README.md` — the visual spec: tokens, layout, screens.
3. `docs/design/SEO Autopilot.dc.html` — the interactive prototype. Open it in a browser with `support.js` alongside. It is a visual reference, not code to copy.

Where the design README and BUILD_SPEC disagree, **BUILD_SPEC wins**. Section 3 of BUILD_SPEC lists every known difference.

## Stack (fixed)
- Next.js (latest stable, App Router), TypeScript in strict mode
- Tailwind CSS (latest stable). Design tokens are defined as theme variables (see BUILD_SPEC §6)
- Neon Postgres, using Drizzle ORM with the Neon serverless driver
- Inngest for background jobs, schedules and retries
- Deployed on Vercel
- Zod to validate every external input: forms, webhooks, API responses

## Non-negotiable rules
- **Reliability over cleverness.** A boring loop that works every week beats a clever one that sometimes doesn't.
- **Postgres is the source of truth.** Third-party systems are inputs or execution targets, never the store of record.
- **Every integration sits behind an interface** in `src/integrations/<provider>`. No provider SDK calls from UI or route code.
- **Idempotency everywhere.** Webhooks, job steps and executions use idempotency keys. A duplicate delivery must never cause a duplicate execution.
- **AI-generated code is never merged automatically.** Claude Code opens PRs; a human merges them.
- **Never fabricate data.** If a metric isn't available, show "—" or leave it out. Never invent services, locations, testimonials or credentials in generated content.
- **Audit-log every meaningful action** (who/what, before, after, result).
- **Mobile first.** Every screen must work well at 375px wide. The operator uses this mostly on a phone.
- **UK conventions:** British English in UI copy, £ for currency, `Europe/London` timezone, dates like `1 Oct 2026`.
- **Only surface what needs a human.** Don't notify on success.

## Working style
- Build phase by phase (BUILD_SPEC §14). Finish and verify one phase before starting the next.
- Before marking any task done, run `pnpm lint`, `pnpm typecheck` and `pnpm build`.
- When a third-party API's real capabilities differ from what the spec assumes, stop and report the difference. Don't work around it silently.
- Ask before adding a new dependency, service or provider not named in the spec.
- Keep secrets in environment variables only (BUILD_SPEC §13). Never commit them.
