# SEO Autopilot

The SEO Autopilot setup PR added these files. SEO Autopilot uses them to make approved SEO changes in this repository with Claude Code. Each run opens a pull request, and a person reviews and merges it. Nothing is merged automatically.

| File | What it does |
| --- | --- |
| `.github/workflows/seo-autopilot.yml` | The SEO Autopilot app starts this workflow with `workflow_dispatch` (inputs `batch_id` and `spec_url`). It fetches the signed batch spec, runs Claude Code (one commit per change), then lint, `next build` and SEO QA. If everything passes, it pushes `seo-autopilot/batch-…` and opens a PR. It reports progress to the app at each stage. |
| `.seo-autopilot/callback.mjs` | Helper for the workflow. It fetches the spec, sends HMAC-signed callbacks (with retries), checks Claude's commits and builds the PR body. It has no dependencies. |
| `.seo-autopilot/qa.mjs` | SEO QA checks against the diff and the `.next` build output. It covers removed routes, noindex/nofollow, canonicals, titles and descriptions, internal links, the sitemap, robots, JSON-LD, redirects, diff size and near-duplicate content. Run `node .seo-autopilot/qa.mjs --self-test` to test its helpers. |

Do not edit these files by hand. The app manages them, and a batch fails if Claude Code changes them.

## Required organisation settings (one-off)

**Actions secrets** (organisation level, available to this repository):

- `ANTHROPIC_API_KEY`: the Anthropic API key Claude Code uses.
- `SEO_AUTOPILOT_CALLBACK_SECRET`: the shared HMAC secret. It must match the app's value.

**Actions → General → Workflow permissions:** turn on "Allow GitHub Actions to create and approve pull requests". Without it, `gh pr create` fails.

**Optional Actions variables:**

- `SEO_AUTOPILOT_MODEL`: the Claude model ID to pass to Claude Code. If unset, Claude Code uses its default model.
- `SEO_AUTOPILOT_ALLOWED_BOTS`: the bot actor allowed to start Claude Code, for example `seo-autopilot[bot]`. The default is `*`. That is safe here because only `workflow_dispatch`, which needs write access, triggers this workflow.
- `SEO_AUTOPILOT_GIT_EMAIL`: the commit author email. The default is `seo-autopilot@users.noreply.github.com`.

## Notes

- The workflow opens the PR with the workflow's `GITHUB_TOKEN`. GitHub does not trigger other `pull_request` workflows (for example CI) for PRs created this way. Vercel preview deployments still run because they use Vercel's GitHub App.
- If the build needs environment variables (for example CMS keys), add them as repository secrets and expose them in the Build step.
