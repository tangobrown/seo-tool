# Claude Code GitHub Action: findings (BUILD_SPEC §15 item 3)

Checked on **3 Oct 2026** against `anthropics/claude-code-action` on `main` (commit `ed670b4`). The moving tag `v1` points at `cb4c302`, and the latest release tag is `v1.0.240`. Sources read: `action.yml`, `README.md`, `docs/usage.md`, `docs/configuration.md`, `docs/solutions.md`, `docs/security.md`, `docs/setup.md`, `docs/faq.md`, `docs/migration-guide.md`, `base-action/README.md`, and the source files `src/entrypoints/run.ts`, `src/modes/detector.ts`, `src/modes/agent/index.ts`, `src/github/token.ts`, `src/github/validation/actor.ts` and `src/github/operations/git-config.ts`. These were fetched from raw.githubusercontent.com. The GitHub API was not reachable from the build session, but the raw files were.

## Summary

- Use `anthropics/claude-code-action@v1` with a `prompt`. A `prompt` puts the action into **agent (automation) mode**, so no `@claude` comment is needed and it works with `workflow_dispatch`.
- **Auth:** pass `anthropic_api_key`. To avoid needing the Claude GitHub App, also pass `github_token: ${{ github.token }}`.
- **Tools and turns:** set them in `claude_args`, using the CLI flags `--allowedTools`, `--disallowedTools`, `--max-turns`, `--model`, `--add-dir` and `--append-system-prompt`. The old `allowed_tools`, `max_turns` and `model` inputs are deprecated.
- **Commits:** Claude can commit with plain `git` once you allow `Bash(git add:*)` and `Bash(git commit:*)`. In agent mode the action does not push, create branches or open PRs; our workflow does those.
- **Gotcha:** agent mode rejects runs started by a bot unless `allowed_bots` lists it. Our app dispatches the workflow as a GitHub App, so the template sets `allowed_bots`.

## Inputs (from `action.yml`)

| Input | Notes |
| --- | --- |
| `prompt` | The instructions. Setting it switches to agent mode (see below). |
| `claude_args` | Raw Claude CLI arguments (parsed with shell-quote; `#` comment lines are stripped). Use `--allowedTools`, `--disallowedTools`, `--max-turns`, `--model`, `--system-prompt` / `--append-system-prompt`, `--mcp-config`, `--add-dir`, `--json-schema` and so on here. |
| `settings` | Claude Code settings as a JSON string or a file path (env, permissions, hooks, model). |
| `anthropic_api_key` | Direct Anthropic API key. Falls back to `env.ANTHROPIC_API_KEY`. |
| `claude_code_oauth_token` | Alternative to the API key (Claude subscription OAuth token). |
| `anthropic_federation_rule_id`, `anthropic_organization_id`, `anthropic_service_account_id`, `anthropic_workspace_id`, `anthropic_oidc_audience` | Workload identity federation: exchanges the GitHub OIDC token for a short-lived Anthropic token, so no API-key secret is needed. Requires `id-token: write`. |
| `use_bedrock` / `use_vertex` / `use_foundry` | Cloud providers (OIDC). |
| `github_token` | The token Claude and the action use for GitHub. **If omitted, the action requests an OIDC token and exchanges it for a Claude GitHub App token**, which requires the Claude app to be installed and `id-token: write`. |
| `base_branch`, `branch_prefix`, `branch_name_template` | Branch naming for tag mode (issues and PRs). Not used by agent mode unless `CLAUDE_BRANCH` is set. |
| `allowed_bots` | Comma-separated bot names, or `*`. Defaults to none. |
| `allowed_non_write_users` | Risky bypass of the write-access check. Not used. |
| `trigger_phrase`, `assignee_trigger`, `label_trigger`, `track_progress`, `use_sticky_comment`, `classify_inline_comments`, `include_fix_links`, `include_comments_by_actor`, `exclude_comments_by_actor` | Tag mode and PR-comment features. Not relevant here. |
| `use_commit_signing`, `ssh_signing_key`, `bot_id` (default `41898282`), `bot_name` (default `claude[bot]`) | Commit identity and signing. |
| `additional_permissions` | For example `actions: read`. |
| `plugins`, `plugin_marketplaces` | Install Claude Code plugins. |
| `path_to_claude_code_executable`, `path_to_bun_executable` | Custom binaries. |
| `display_report`, `show_full_output` | Step summary and full JSON logs. Both default to `false`. `show_full_output` can leak secrets into logs. |

Deprecated (still accepted): `mode`, `direct_prompt`, `override_prompt`, `custom_instructions`, `max_turns`, `model`, `fallback_model`, `allowed_tools`, `disallowed_tools`, `mcp_config` and `claude_env`. Each one maps to `prompt`, `claude_args` or `settings`.

**Outputs:** `conclusion` (`success` / `failure`), `execution_file` (a JSON array of SDK messages; the last `type: "result"` entry has `subtype`, `is_error`, `num_turns` and `result`), `branch_name`, `github_token`, `structured_output` (with `--json-schema`) and `session_id`.

## Headless use (no `@claude`)

`src/modes/detector.ts`: for non-entity events such as `workflow_dispatch`, `schedule` and `repository_dispatch`, the mode is always **agent**. The run goes ahead only if `prompt` is non-empty. Agent mode (`src/modes/agent/index.ts`):

1. Calls `checkHumanActor`. If `github.actor` is a bot or app and is not in `allowed_bots`, the run fails with "Workflow initiated by non-human actor". **Our app dispatches as a GitHub App (`<slug>[bot]`), so `allowed_bots` must be set.** The template uses `vars.SEO_AUTOPILOT_ALLOWED_BOTS || '*'`. `docs/security.md` says `workflow_dispatch` is not separately permission-checked "because GitHub itself requires write access to dispatch a workflow".
2. Sets `git config user.name/user.email` to `bot_name` / `bot_id`, and replaces the checkout credential with the action's token. Our template sets `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars at job level, so commits are authored as "SEO Autopilot". Env vars override git config.
3. Writes the prompt to `$RUNNER_TEMP/claude-prompts/claude-prompt.txt` and adds its own GitHub MCP servers.
4. Creates no tracking comment and no branch. It works on whatever is checked out. In our template the `seo-autopilot/batch-…` branch is created before the action runs.

Example from `docs/solutions.md` (a scheduled or `workflow_dispatch` job) in the documented style:

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    prompt: "…"
    claude_args: |
      --allowedTools "Read,Write,Edit,Bash(git:*)"
      --max-turns 10
```

## Default tools and committing

`docs/configuration.md`: by default Claude gets "file operations (reading, committing, editing files, read-only git commands)" plus the GitHub MCP tools. It does **not** get arbitrary Bash, so every extra command must be allowed through `--allowedTools`. The docs example for committing to a branch uses `--allowedTools "Read,Write,Edit,Bash(git:*)"`. Our template allows only `git add`, `commit`, `status`, `diff`, `log`, `show`, `restore`, `rm` and `mv`, plus `<pm> run lint` and `npx tsc --noEmit`. It explicitly disallows `git push`, `reset`, `rebase`, `checkout`, `switch` and `branch`, as well as `WebFetch` and `WebSearch`. Claude can write files outside the repository only in the directory passed with `--add-dir`, which holds the results JSON.

`docs/capabilities-and-limitations.md`: Claude "cannot merge branches, rebase, or perform other git operations beyond pushing commits". In our setup the workflow pushes and opens the PR with `gh`, not Claude.

## Auth decision for SEO Autopilot

- `anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}` (organisation secret), as the spec assumes.
- `github_token: ${{ github.token }}`. With this, the official Claude GitHub App is **not** needed and `id-token: write` is not needed. The job's `permissions` (`contents: write`, `pull-requests: write`) limit the token.
- **Later option:** workload identity federation would remove the long-lived API key. It needs `id-token: write` and a federation rule per org or repo.

## Things that differ from what BUILD_SPEC assumes

1. **Bot actor check.** Not in the spec. Without `allowed_bots`, every app-dispatched run would fail before Claude starts.
2. **Git identity.** The action overwrites `git config user.*` with `claude[bot]`. The template handles this with `GIT_*` env vars (see above).
3. **PRs opened with `GITHUB_TOKEN`.** Two consequences:
   - The org or repo setting "Allow GitHub Actions to create and approve pull requests" must be on.
   - PRs opened this way do not trigger the client repo's own `pull_request` workflows (GitHub's anti-recursion rule).

   If client CI on the PR matters, the workflow would need a GitHub App token, for example from `actions/create-github-app-token` with the SEO Autopilot app's key as an org secret. That would add a third secret.
4. **`--max-turns`** is documented by the action but hidden from `claude --help` in CLI 2.1.288. The flag is still present in the CLI binary as a hidden option, and the action documents it as the replacement for `max_turns`. The CLI also has `--max-budget-usd` (headless only), which could be used as a cost cap.
5. **Concurrency.** A GitHub `concurrency` group holds at most one *pending* run. A third dispatch cancels the queued second one. The app already allows only one running GitHub job per client (Inngest concurrency key), so this is fine. The app should not dispatch a second batch before the first finishes.

## Fallback (not used): CLI headless mode

If the action ever becomes unsuitable, the equivalent is:

```bash
npx -y @anthropic-ai/claude-code@latest -p "$(cat prompt.txt)" \
  --max-turns 150 --output-format json \
  --allowedTools "Read,Write,Edit,Glob,Grep,Bash(git add:*),Bash(git commit:*)" \
  --add-dir "$RUNNER_TEMP/seo-autopilot"
```

Set `ANTHROPIC_API_KEY` in the step env. The latest npm version on 3 Oct 2026 is 2.1.288. This skips the actor check and the git-config rewrite, but loses the action's MCP setup and its execution-file and summary handling. The low-level `anthropics/claude-code-base-action` is another option. It has no actor checks, and its README says the caller must make sure the prompt and working directory are trusted.
