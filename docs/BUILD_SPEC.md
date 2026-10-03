# SEO Autopilot — Build Specification

This is the source of truth for the build. It combines three inputs:

- the original product brief (automated SEO agency platform)
- decisions made since the brief was written
- the high-fidelity design mock in `docs/design/`

Where this document and the design README disagree, this document wins. Section 3 lists every difference.

---

## 1. What we're building

An internal web app for a UK SEO agency with a handful of small-business clients. One operator uses it, mainly from a phone.

The app behaves like an SEO operations employee. It runs this loop for every client:

```
OBSERVE → ANALYSE → RECOMMEND → APPROVE → EXECUTE → VERIFY → MEASURE → LEARN → repeat
```

The operator only does three things:

1. **Adds a client** with one short form. Everything else is discovered automatically and confirmed once.
2. **Reviews recommendations** after each scheduled scan. They select several and tap Approve, Defer or Decline. An approved batch is executed automatically: website changes become a GitHub PR written by Claude Code, and supported Google Business Profile changes go through the GBP API.
3. **Sends the monthly report.** On the 1st of each month a client-ready report appears. The operator reviews it, copies it into an email and marks it sent.

Everything else happens in the background. The app only asks for attention when a human is genuinely needed.

**Engineering priorities, in order:**

1. Reliability
2. Automation
3. Ease of approval on mobile
4. Safety
5. Explainability
6. Scalability
7. Intelligence
8. Extra features

---

## 2. Decisions already made (do not revisit)

| Topic | Decision |
|---|---|
| Human interface | **Our own web app.** No ClickUp. |
| Users | **A single operator.** One login page, no sign-up, no roles. |
| Code execution | **Claude Code** (not Codex), running in **GitHub Actions** on each client repo and dispatched by our app. |
| Approval flow | **Tapping Approve on a selection creates a batch** that starts after a short **undo window** (default 2 min, configurable). There is no separate "run" button. |
| PRs | **One PR per batch**, with **one commit per recommendation**. Never auto-merge. |
| SEO data | **SiteGuru** is the primary SEO data source. No direct GSC/GA4 integration in the MVP. |
| Local SEO | **Localo is dropped.** Local data comes from the **GBP API** (profile, performance, reviews) plus a **SERP provider** (local pack / Maps rankings for priority services in each served town). |
| Client websites | All clients are **Next.js sites in GitHub**. There is no CMS integration. |
| Blog posts | The tier's posts per month is a **promise to the client**: exactly N posts every month. Each topic must still be backed by evidence (see §10.6). |
| Monthly email | MVP: **"Copy for email"** (plain text + HTML) and **"Mark as sent"**. A Gmail draft is a later phase. |
| Notifications | Sent to **Slack** (incoming webhook). The operator is only notified about things needing attention. |
| Hosting | **Vercel** + **Neon Postgres**. Background jobs run on **Inngest**. |

---

## 3. Differences from the design mock

The mock is the authority on look and feel. Behaviour and content change as follows:

| Mock | Build |
|---|---|
| Integrations: Search Console, GA4, WordPress, Shopify, Webflow, Slack, Gmail | **SiteGuru, GitHub, Google Business Profile, SERP provider, Anthropic, Slack** (Gmail listed as "Coming later") |
| Top bar: "Synced with Search Console 12 min ago" | "Synced with SiteGuru 12 min ago" (latest successful SiteGuru sync for the current client, or across all clients on the dashboard) |
| Prices in $ | **£** (display only; there is no billing) |
| Client "CMS" field | **GitHub repository**, plus connection status for SiteGuru site and GBP location |
| Approve toast: "batch sent to Claude Code" | "{n} changes approved — starting in 2 min" with Undo. Undo also remains available in the Actioned tab until the batch starts. |
| Recommendation row: title, description, URL only | Add an expandable **Details** panel showing Why, Evidence, Proposed action, Expected benefit, Execution and Risk (§7.4). Blog drafts get "Preview draft". |
| Categories: Technical, On-page, Content, Links | Add **Local** (yellow tag) for GBP/local work |
| Actioned tab: decision status only | Add **execution status** per item (§7.5): Queued, Running, PR ready, Live, Failed, Action needed |
| No failure/attention view | New **Needs attention** page and sidebar item (§7.9) |
| No login | New **Login** page (§5) |
| New Client modal: name, website, email, tier | Add **contact name** and **GitHub repository** fields. Everything else is discovered (§9.1). |
| Client Settings: Tier, Details, Automation | Add **Strategy** (services, locations, exclusions, tone) and **Connections** sections |
| Workspace Settings: General, Tiers, Integrations, Notifications | Add **Strategy** (weighting, later phase) and **Activity** (audit log). Integrations show health, not just connected or not. |
| Desktop-only layout (sidebar fixed at 240px) | **Fully responsive, mobile-first** (§6.3) |
| Blog posts / month as tier capacity | A **commitment**, tracked per client per month (§10.6) |

---

## 4. Architecture

```
                 ┌──────────────────────────────┐
  Phone/desktop →│  Next.js app (Vercel)        │
                 │  UI + server actions + API   │
                 └──────┬───────────────┬───────┘
                        │               │
                  Neon Postgres      Inngest (jobs, schedules, retries)
                        │               │
     ┌──────────────────┼───────────────┼─────────────────────┐
     ▼                  ▼               ▼                     ▼
  SiteGuru         GBP API        SERP provider         Anthropic API
  (SEO data)       (local data    (rankings,            (wording, classification,
                    + execution)   local pack)           reports, blog drafts)
                                        │
                        GitHub App ─────┘
                           │
                 workflow_dispatch → client repo GitHub Action
                           │
                 Claude Code → commits → QA → PR → callback to our app
```

**Code layout (suggested):**

```
src/
  app/                    Next.js routes (UI, API, webhooks)
  components/             UI components built to the design tokens
  db/                     Drizzle schema, migrations, seed
  domain/                 Pure business logic: scoring, fingerprinting, selection, report assembly
  jobs/                   Inngest functions
  integrations/
    siteguru/             implements SEODataProvider
    gbp/                  implements BusinessProfileProvider
    serp/                 implements SERPProvider (DataForSEO first)
    github/               implements CodeExecutionProvider
    anthropic/            implements LLMProvider
    slack/                implements NotificationProvider
  lib/                    auth, audit, idempotency, crypto, dates
templates/
  client-repo/            Workflow + QA script added to each client repo by the setup PR
```

The `domain/` code must not import from `integrations/`. Pass data in, get decisions out. This keeps scoring and selection testable.

---

## 5. Authentication and login

There is one operator, and credentials come from environment variables.

- `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` (argon2id or bcrypt). Include a script, `pnpm hash-password`, to generate the hash.
- Sessions: a signed, encrypted, httpOnly, Secure, SameSite=Lax cookie (e.g. with `jose`). They last **30 days, rolling**, because the operator is on a phone and shouldn't have to log in often.
- **Rate limiting:** a maximum of 5 failed attempts per IP per 15 minutes, tracked in Postgres. Use a constant-time compare and a generic error message.
- `middleware.ts` redirects unauthenticated requests to `/login`. These routes are excluded: `/login`, `/api/webhooks/*`, `/api/inngest`, `/api/github-callback/*`, static assets, the manifest and icons.
- **Every server action and API route checks the session itself** as well. Never rely on middleware alone.
- There's a **Sign out** link at the bottom of the sidebar. There is no sign-up and no password reset; the password is reset by changing the env var.

**Login page design** (match the mock's language):

- White page.
- A centred column, max-width 360px, about 20vh from the top.
- Workspace mark: a 22px dark square with initials, then the workspace name at 14px/600.
- H1 "Sign in" at 24px/700, letter-spacing -0.02em.
- Fields: Email and Password, styled like the New Client modal (13px `#7d7b76` labels; inputs with a `#e3e2de` border, radius 6, focus border `#a5a39e`).
- A full-width primary "Sign in" button. It shows "Signing in…" and is disabled while submitting.
- Error text: "Incorrect email or password." in 13px `#a23b2c`.
- Must look right at 375px and support password managers (`autocomplete="username"` / `"current-password"`).

---

## 6. Design system

### 6.1 Source
`docs/design/README.md` defines every colour, size, radius, spacing value and tag mapping. Recreate the screens to match it. Use **Inter** via `next/font`.

### 6.2 Tailwind tokens
Define the README's tokens as theme variables so components use names like `text-ink`, `bg-sidebar`, `border-line` instead of raw hex values. Minimum set:

```
ink #2f2e2b          ink-hover #000
ink-2 #45433f        ink-3 #5f5d58
muted #7d7b76        subtle #9a9893      subtle-2 #a5a39e     faint #cfcdc8
line #ebeae6         control #e3e2de
sidebar #f8f7f5      hover #f3f2ef       hover-2 #efeeeb      row-hover #fbfbfa
toggle-off #dcdbd7   disabled #b9b7b2
positive #2a6b45     negative #a23b2c    alert #d4574a
tag-gray   #efeeeb/#5f5d58     tag-green  #e4f1e8/#2a6b45
tag-red    #fbe8e5/#a23b2c     tag-yellow #faf0d9/#8a6116
tag-blue   #e4edfa/#2a5ca8     tag-purple #eee8f6/#6a4a9c
tag-orange #fbeadb/#9a5420
```

Build these shared primitives once:

- `Tag`, `Button` (primary/secondary/danger), `Checkbox`, `Toggle`, `PropertyRow`, `ChipInput`
- `Tabs`, `Toast` (with Undo), `Modal` (with mobile sheet variant), `EmptyState`, `KpiStrip`, `BarChart`

**Tag mappings:**

- **Category:** Technical = blue, On-page = purple, Content = orange, Links = green, **Local = yellow**
- **Impact:** High = red, Medium = yellow, Low = gray
- **Decision:** Pending = gray, Approved = green, Deferred = yellow, Declined = red
- **Execution:** Queued = gray, Running = blue, PR ready = purple, Live = green, Failed = red, Action needed = yellow
- **Tier:** Starter = gray, Growth = blue, Pro = purple

### 6.3 Responsive behaviour (mobile is the primary device)

Design for **375px first**, then scale up. Breakpoint for the desktop layout: `md` (768px).

**Below 768px:**

- **Sidebar** becomes a slide-over drawer, opened from a menu button at the top left of the top bar. It closes on navigation or a backdrop tap.
- **Top bar** shows the menu button, then a back chevron (to the parent breadcrumb), then the current page title. The sync status is hidden.
- **Content padding** is `20px 16px 120px`.
- **Clients table** becomes a list. Line 1: client name and tier tag. Line 2: pending status (left) and clicks with delta (right). The whole row is tappable.
- **Tabs** scroll horizontally without a visible scrollbar.
- **Recommendations:**
  - Select-all stays sticky at the top.
  - Once at least one item is selected, the Decline / Defer / Approve buttons move to a **fixed bottom action bar**. It respects `env(safe-area-inset-bottom)`, and its buttons are at least 44px tall.
  - Row checkboxes keep the 16px visual size but have a hit area of at least 44px.
- **KPI strip** becomes a 2×2 grid.
- **Property lists** stack the label above the value.
- **Tables in Settings** (Tiers) become stacked cards, one per tier.
- **Modals** become full-width bottom sheets.
- **Toasts** sit above the bottom action bar.

**Everywhere:**

- Inputs use **16px font size on mobile** to stop iOS from zooming on focus. This is a deliberate deviation from the mock's 13–14px.
- Tap targets are at least 44×44px.
- Use the viewport meta `viewport-fit=cover` and safe-area padding.
- **PWA basics:** `manifest.webmanifest` (name "SEO Autopilot", `display: standalone`, theme colour `#f8f7f5`), plus app icons and an apple-touch-icon, so the operator can add the app to their home screen. Offline support is not needed.
- No layout shift on load. Use skeleton rows matching the row heights.
- Transitions are 150ms ease on background and colour only.

---

## 7. Screens

All screens from the mock, with the additions below. Copy can be adjusted for UK English.

### 7.1 Sidebar

- Workspace header, then the nav items in this order:
  1. **Needs attention** (red count pill when above 0)
  2. **Clients** (count)
  3. **Settings**
- Then the "Your clients" list with pending pills, then "+ Add client".
- **Sign out** pinned at the bottom (13px `#a5a39e`).

### 7.2 Clients dashboard

Same layout as the mock. The table columns are Client | Tier | Pending | Last report | Organic clicks (30d).

**Pending column values:**

- "{n} pending" with a red dot
- "All reviewed"
- "Scanning site…" (during onboarding)
- **"Confirm details"** (when onboarding is awaiting confirmation; links to the client's Settings tab)
- "Paused"

**Organic clicks (30d)** comes from the latest SiteGuru sync. Show "—" if it's unavailable.

**Attention banner:** if any Needs-attention items are open, show it above the toolbar. It uses the same style as the mock's report banner: "**3 things need your attention.** 1 failed job · 2 PRs to review  Open →".

### 7.3 Client page header

Same as the mock. The meta row reads:

`domain · tier tag · {posts} posts / month · {cadence} scans · Posts this month: {x} of {n}`

The "Posts this month" segment turns `#8a6116` if the client is behind schedule (§10.6).

Tabs: **Recommendations | Actioned | Reports | Settings**.

### 7.4 Recommendations tab

Behaviour follows the mock (row tap toggles selection, sticky bulk toolbar, Approve / Defer / Decline on the selection), plus the following.

**Details panel.** Each row has a "Details" text button with a chevron, on the right of the tags row (12px `#a5a39e`). It expands an inline panel **without** toggling selection. The panel is a property list:

| Label | Content |
|---|---|
| Why | 1–2 sentences |
| Evidence | Bullets, each ending with a source tag (SiteGuru / GBP / SERP / Site crawl). Example: "Ranks #6 for 'boiler repair exeter' (SiteGuru) · 320 impressions/month". |
| Proposed action | What will change |
| Expected benefit | What it should improve |
| Execution | "Claude Code → GitHub PR", "Google Business Profile API" or "Manual — you'll get a checklist" |
| Risk | Low / Medium / High |

**Blog drafts** (Content items from the blog commitment) also show "Preview draft". It opens a reading view in the same style as the report document (680px).

**Approve flow:**

1. Create a batch with `starts_at = now + undo_window` (§11.1).
2. Toast: "{n} changes approved — starting in 2 min" with **Undo**.
3. Approved items leave the list.

**Defer** sets `deferred_until = now + 28 days` (configurable). The item resurfaces automatically after that if it's still valid.

**Decline** suppresses the item (§10.4).

**Empty states** as in the mock, plus "Waiting for you to confirm this client's details" for clients that are awaiting confirmation.

The footnote changes to: "Approved changes start after a short undo window. Website changes arrive as one pull request per batch."

### 7.5 Actioned tab

Same as the mock: filter pills, rows, and "Move back". Additions:

- **Who and when:** each row shows "Approved 6 Oct, 09:14" (or "Auto-approved", or "Deferred until 3 Nov").
- **Execution status tag** for approved items (colours in §6.2):

  | Status | Meaning |
  |---|---|
  | Queued | In the undo window. Shows a countdown ("Starts in 1:42") and a **Cancel batch** link. |
  | Running | Claude Code or the GBP API is working on it |
  | PR ready | Shows an **"Open PR ↗"** link to GitHub |
  | Merged | Merged; waiting for production verification |
  | Live | Verified in production (or GBP change verified) |
  | Failed | Shows the error summary and a **Retry** link |
  | Action needed | A manual step is required; links to the Needs attention item |

- **"Move back"** is only available for Deferred and Declined items, or for Approved items while still Queued (which cancels them out of the batch). Once a batch is running, show the execution status instead.
- **Batch grouping:** approved items from the same batch are grouped under a 12px `#a5a39e` subheading: "Batch · 6 Oct 09:14 · 5 changes · PR #42".

### 7.6 Reports tab

Same structure as the mock. All data comes from our stored snapshots of SiteGuru data (§9.2), never from live calls on page load.

- **KPI strip:** Organic clicks, Impressions, Avg. position (lower is better), CTR. Last 30 days vs the previous 30. Show "—" for anything SiteGuru doesn't provide.
- **"Organic clicks by month":** 12 bars. If SiteGuru can't provide 12 months of history, show the months we have and grey placeholders for the rest. Build history from monthly snapshots over time.
- **Top pages / Top keywords:** from SiteGuru.
- **Local visibility** (new, shown once SERP and GBP are live): a compact table of priority services × served towns showing local pack position and the 30-day change, plus GBP calls, direction requests and website clicks. Hide the section if there's no data.
- **Monthly reports list and document view:** as in the mock.
  - Add a secondary button **"Mark as sent"** next to "Copy for email". It turns into the tag "Sent 2 Nov".
  - "Copy for email" writes `text/plain` and `text/html` to the clipboard (with an `execCommand` fallback), as the README describes.

### 7.7 Client Settings tab

Sections, separated by 36px:

1. **Tier.** As in the mock, with prices in £.
2. **Details.** As in the mock, minus CMS. Fields: Website, Primary contact, Contact email, Industry, Primary location, Target keywords (chips).
3. **Strategy** (new). Property rows with chip inputs:
   - **Services**, with **Priority services** as a chip subset (tapping a service chip's star marks it as a priority)
   - **Locations served**
   - **Excluded services**
   - **Excluded locations**
   - **Brand tone** (single-line text)
   - Subcopy: "Recommendations and content only ever use these services and locations."
   - When onboarding is awaiting confirmation, show a banner at the top of this section: "**We found 6 services and 4 locations on the website.** Check them, then confirm to start recommendations." Add a primary **Confirm and activate** button.
4. **Connections** (new). One row each for Website, GitHub repository, SiteGuru site and Google Business Profile location. Each row shows:
   - status (Connected / Not found / Error, in green or red text, like the mock's Connected label)
   - last successful sync
   - an action: Change, Retry or Connect
   - For the GBP location, Connect opens a picker listing locations from the connected Google account.
5. **Automation.** The mock's three toggles:
   - **"Auto-approve low-impact fixes."** Limited to alt text, schema markup and image compression. These still go through a PR; they just skip review.
   - **"Review blog posts before publishing."**
   - **"Include in monthly report."**
   - Add a fourth: **"Pause automation"**, with the description "Stop scans and executions for this client".
6. **Archive client.** Add a confirmation dialog. Archived clients appear under a "Show archived" link on the dashboard and can be restored.

All fields autosave, debounced at 500ms. Every change is audit-logged.

### 7.8 Workspace Settings

Tabs: **General | Tiers | Strategy | Integrations | Notifications | Activity**.

- **General.** As in the mock, plus:
  - **Undo window** (seconds, default 120)
  - **Recommendations per scan** (target, default 10)
  - **Minimum recommendation score** (default 65)
  - **Scan day and time** (default Monday 06:00)
  - The "Monthly report" read-only row stays.
- **Tiers.** The mock's table, with prices in £. Defaults (placeholders the operator will edit):

  | Tier | Posts / month | Scans | Price |
  |---|---|---|---|
  | Starter | 2 | Monthly | £450 |
  | Growth | 4 | Fortnightly | £900 |
  | Pro | 8 | Weekly | £1,800 |

- **Strategy** (Phase 9). An Auto/Custom mode switch and category weight sliders (§10.5). Client-level overrides live on the client's Settings tab when Custom is chosen there. Before Phase 9, show "Automatic" read-only.
- **Integrations.** One row per provider, following the mock's row style:
  - Providers: SiteGuru, GitHub (GitHub App), Google Business Profile, SERP provider, Anthropic, Slack, and Gmail ("Coming later", disabled).
  - Each row shows: status (Connected / Error / Not connected), **last successful sync**, **last failure**, and an expandable **last error message**.
  - Connect actions: install the GitHub App, Google OAuth, or enter an API key, depending on the provider.
- **Notifications.**
  - The mock's toggles: New recommendations, Monthly reports ready, Weekly digest.
  - Add **"Failures and things that need action"** (default on).
  - Add a **Slack webhook URL** field and a "Send test" link.
- **Activity.** The audit log, newest first. Each entry shows time, client, actor (You / System / Claude Code / Webhook) and event, and expands to show before/after. Filter by client; paginate 50 at a time.

### 7.9 Needs attention (new page)

The H1 "Needs attention", with subtitle "{n} items". Rows use the same row style as recommendations (no checkbox). Each row has a **kind tag**, a client name in muted text, a title, a one-line detail, and actions on the right.

| Kind | Example | Actions |
|---|---|---|
| PR to review | "PR #42 ready — 5 changes for Exeter Heating" | Open PR ↗ |
| Failed | "Batch failed at QA: canonical missing on /boiler-repair" | Retry · Details |
| Manual action | "Change GBP primary category (manual)" + checklist | Mark done |
| Integration | "SiteGuru sync failing for 2 clients" | Open integration |
| Confirm client | "Confirm services and locations for Exeter Heating" | Review |
| Blog commitment | "2 of 4 posts still to approve this month" | Open recommendations |
| Report ready | "October report ready for Exeter Heating" | Open report |

Items resolve automatically when the underlying condition clears. For example, a "PR to review" item resolves when the PR is merged or closed, and a "Report ready" item resolves when the report is marked sent. Manual items resolve via "Mark done". Use a unique `dedupe_key` per condition so the same issue never appears twice.

Empty state: "Nothing needs you right now."

### 7.10 New Client modal

Same design as the mock. Fields:

- Client name *
- Website *
- Contact name
- Contact email
- Tier (segmented control)
- **GitHub repository** *: a select listing the repos the GitHub App can access. If the App isn't installed yet, it falls back to a text field (`owner/name`).

"Add client" is disabled until the required fields are filled in. On create, navigate to the client and show the toast "{name} added — setting up". Onboarding then runs in the background (§9.1).

---

## 8. Data model (Postgres via Drizzle)

Use UUID primary keys. Each client also gets a human-readable `ref` (`CLIENT-0001`, from a sequence). All timestamps are `timestamptz`. Every client-scoped table has `client_id` and an index on it. The names below are guidance; adjust if needed, but keep the concepts.

```
workspace            single row: name, sender_name, reply_to, signoff, undo_window_seconds,
                     recs_per_scan, min_score, scan_day, scan_time, defer_days,
                     notifications jsonb, slack_webhook_url (encrypted), weighting_mode, weights jsonb

tiers                id, name, posts_per_month, scan_frequency (weekly|fortnightly|monthly),
                     price_pence, sort_order

clients              id, ref, name, domain, website_url, status (onboarding|awaiting_confirmation|
                     active|paused|archived), tier_id, contact_name, contact_email, industry,
                     primary_location, brand_tone, keywords text[], services text[],
                     priority_services text[], locations text[], excluded_services text[],
                     excluded_locations text[], auto_approve_low_impact bool,
                     review_blog_posts bool, include_in_monthly_report bool,
                     weighting_mode nullable, weights jsonb nullable,
                     github_repo, github_default_branch, siteguru_site_id, gbp_location_id,
                     onboarding jsonb (step results), created_at, archived_at

integrations         provider, status, config jsonb (non-secret), last_success_at,
                     last_failure_at, last_error
client_connections   client_id, provider, status, external_id, last_success_at,
                     last_failure_at, last_error
oauth_tokens         provider, account, access_token_enc, refresh_token_enc, expires_at
                     (AES-256-GCM, key from ENCRYPTION_KEY)

pages                client_id, url, path, page_type (homepage|service|location|service_location|
                     blog|about|contact|other), service, location, commercial_intent,
                     title, h1, canonical, indexable, internal_links_in, internal_links_out,
                     target_queries text[], last_crawled_at

opportunities        id, client_id, fingerprint (unique per client), type, category
                     (technical|on_page|content|links|local), title, description, why,
                     proposed_action, expected_benefit, target_url, target_query,
                     evidence jsonb, evidence_hash, impact, commercial_value, confidence,
                     effort, risk (1–10 each), priority_score, impact_label (high|medium|low),
                     risk_label, execution_type (github_pr|gbp_api|content_generation|
                     manual_action|outreach_draft), status (candidate|recommended|reserve|
                     approved|executing|completed|deferred|declined|stale),
                     deferred_until, decided_at, decided_by, batch_id,
                     is_blog_commitment bool, payload jsonb (e.g. blog draft, GBP change),
                     first_detected_at, last_detected_at, times_recommended

batches              id, client_id, idempotency_key unique, created_by (operator|auto),
                     status (pending_start|cancelled|running|awaiting_merge|completed|
                     partially_failed|failed), starts_at, started_at, finished_at

executions           id, batch_id, opportunity_id, execution_type, status (queued|running|
                     pr_ready|merged|live|failed|action_needed|cancelled),
                     idempotency_key unique, attempt, error, result jsonb,
                     started_at, finished_at

github_jobs          id, batch_id, client_id, repo, branch, workflow_run_id, pr_number, pr_url,
                     status, qa_results jsonb, callback_token_hash, merged_at, verified_at

gbp_changes          id, execution_id, client_id, field, before jsonb, proposed jsonb,
                     after jsonb, api_response jsonb, status (proposed|awaiting_approval|
                     approved|submitted|verification_pending|verified|failed|
                     manual_action_required), submitted_at, verified_at

metric_snapshots     client_id, source (siteguru|gbp|serp), period_start, period_end,
                     metrics jsonb, captured_at
serp_snapshots       client_id, query, location, captured_at, client_local_position,
                     client_organic_position, local_pack jsonb, organic jsonb

blog_commitments     client_id, period (YYYY-MM), committed, planned, drafted, approved,
                     published
monthly_reports      id, client_id, period (YYYY-MM), status (generated|read|sent), generated_at,
                     read_at, sent_at, summary, sections jsonb, metrics jsonb,
                     email_text, email_html

attention_items      id, client_id nullable, kind, title, detail, link, dedupe_key unique,
                     status (open|resolved), created_at, resolved_at
automation_runs      id, client_id, kind, status, started_at, finished_at, stats jsonb, error
webhook_events       provider, delivery_id unique, received_at, processed_at
audit_log            id, at, actor (operator|system|claude_code|webhook), client_id,
                     entity_type, entity_id, event, before jsonb, after jsonb, meta jsonb
login_attempts       ip, at, success
opportunity_results  opportunity_id, metric, baseline, after_28d, after_56d, signal,
                     confidence   (Phase 9)
```

The mock's "Recommendation" is an **opportunity with status `recommended`**. "Pending" in the UI equals `recommended`.

Provide a **seed script** that recreates the mock's data, so the UI can be built and reviewed before any integration exists.

---

## 9. Integrations

Every provider implements an interface in `src/integrations/<name>`. Every call runs through a shared wrapper that does timeouts, retries with backoff, and logging to `automation_runs`. It also updates the integration's health record (`last_success_at` / `last_failure_at` / `last_error`).

### 9.1 Onboarding flow (`client.onboard`)

Run as an Inngest function. Each step is recorded in `clients.onboarding`. If a step fails, it creates an attention item and the rest continue where possible.

1. **Create the client** (status `onboarding`, `ref` assigned).
2. **Check the website.** It must be reachable, following redirects. Record the canonical domain.
3. **Check GitHub.**
   - The App has access to the repo, and `package.json` lists `next`.
   - Record the default branch.
   - If `.github/workflows/seo-autopilot.yml` is missing, open a **setup PR** adding the workflow and the QA script from `templates/client-repo/`. Create a "PR to review" attention item for it.
4. **Match SiteGuru.** Find the SiteGuru site whose domain matches. If none matches, create an attention item: "Add {domain} to SiteGuru".
5. **Match GBP.** List the locations under the connected Google account and match on website URL or name. If there's exactly one confident match, propose it; otherwise ask via an attention item.
6. **Crawl the site** (sitemap.xml first, then capped internal links up to about 300 pages). Build the `pages` inventory and classify page types with the LLM, with Zod validation.
7. **Discover services and locations** from site content using the LLM. Store them as proposed values.
8. **First SiteGuru sync** (§9.2).
9. Set the status to **`awaiting_confirmation`** and create a "Confirm client" attention item.
10. When the operator taps **Confirm and activate**: set the status to `active`, run the SERP baseline for priority services × locations (§9.4), then run the first opportunity scan.

### 9.2 SiteGuru (`SEODataProvider`)

SiteGuru is the primary SEO data source. **First task of Phase 3:** confirm how it can be accessed programmatically. It exposes an MCP server at `https://mcp.siteguru.co/mcp`; check whether a REST API also exists, how authentication works, and what the rate limits are. Then build the provider against whichever is more reliable.

The MCP server currently exposes the tools below, with the use for each:

| SiteGuru tool | Use |
|---|---|
| `list_sites` | Onboarding match |
| `get_seo_report`, `get_todo_list`, `get_page_report`, `find_pages` | Technical issues and page health |
| `get_traffic_overview`, `get_traffic_sources` | KPIs, monthly reports |
| `get_top_pages`, `get_top_keywords`, `get_tracked_keywords`, `get_focus_keywords` | Reports tab, ranking context |
| `get_low_hanging_fruit` | ranking_opportunity |
| `get_declining_content`, `get_page_content_trend`, `get_lost_keywords` | existing_page_optimisation, monthly report context |
| `get_growing_content`, `get_new_keywords` | Highlights for monthly reports |
| `get_keyword_cannibalization` | On-page opportunities |
| `get_search_topics` | Content gaps |
| `get_backlink_opportunities`, `list_competitor_analyses`, `get_competitor_analysis` | Links, competitor_gap |

Sync results are stored in `metric_snapshots` and used to update opportunities. The UI never calls SiteGuru directly.

**GA4 check (from the brief):** before Phase 8, determine whether SiteGuru exposes conversion or key-event data. If it doesn't, monthly reports omit conversions; never estimate them. A minimal direct GA4 integration may be added later, only for conversions.

### 9.3 Google Business Profile (`BusinessProfileProvider`)

- Google OAuth with offline access. Tokens are stored encrypted.
- **Read:** location profile (categories, services, hours, description, attributes), performance metrics (calls, direction requests, website clicks, impressions) and reviews (count, rating, unanswered).
- **Write:** only low-risk fields the official API supports. Confirm the list in Phase 6; likely candidates are services, description and some attributes. **Always manual:** name, address, primary category, phone, and anything identity-related.
- Every write stores before, proposed, the API response, and after (re-read after submission).
- Google may hold edits for review. Use the `verification_pending` status and re-check every 6 hours, for up to 72 hours.
- **Note:** GBP API access requires an application to Google, which can take weeks. Apply early; the rest of the build doesn't depend on it.

### 9.4 SERP provider (`SERPProvider`)

- Start with **DataForSEO** (organic, local pack and Maps results for a specific location). Keep it swappable.
- **Tracked queries per client:** priority services × served locations (e.g. "boiler repair exeter"), capped at **30 per client** (configurable). Refresh at the client's scan cadence. Never track long-tail keywords in bulk.
- Store results in `serp_snapshots`. Use them for local visibility, competitor discovery (domains that recur in the top results), and content gaps (what ranking pages cover that ours don't).
- Record the cost per run in `automation_runs.stats`.

### 9.5 GitHub (`CodeExecutionProvider`)

- A **GitHub App** installed on the agency's org or repos. Permissions: Contents (read/write), Pull requests (read/write), Actions (read/write, for dispatch), Workflows (read/write, for the setup PR), Metadata (read).
- App webhooks we handle: `pull_request` (closed/merged), `workflow_run` (completed), `installation_repositories`.
- Verify webhook signatures and dedupe by delivery ID (`webhook_events`).
- Execution details are in §11.2.

### 9.6 Anthropic API (`LLMProvider`)

- The model is set by `ANTHROPIC_MODEL`.
- **Used for:** page classification, service/location discovery, writing recommendation text **from supplied evidence**, report prose, and blog topic briefs and drafts.
- **Always** request structured JSON and validate it with Zod. Retry once on a validation failure, then fail the step visibly.
- **Never** use the LLM as a source of numbers or facts. Numbers come from stored data and are inserted by code.
- Prompts live in `src/integrations/anthropic/prompts/`, versioned. Store the prompt version on generated records.

### 9.7 Slack (`NotificationProvider`)

- An incoming webhook. Messages are short and link straight into the app.
- **Sends only for:**
  - recommendations ready after a scan: "12 new recommendations across 3 clients"
  - failures
  - PRs ready
  - manual actions
  - integration errors
  - monthly reports ready
  - the weekly digest, if enabled
- Respect the toggles in Settings → Notifications. Batch notifications from one scheduled run into a single message.

---

## 10. Opportunity engine

### 10.1 Pipeline (per client, `client.scan`)

```
sync SiteGuru → sync GBP → refresh SERP (if due) → refresh page inventory (changed pages)
→ detect candidates → update existing (fingerprint match) → mark stale
→ score → apply strategy guards → apply weighting → apply safety rules
→ select recommendations → write LLM text from evidence → notify
```

Scans run at the tier cadence on the workspace scan day and time (Europe/London):

- **Weekly:** every scan day.
- **Fortnightly:** on ISO weeks matching the client's start week parity.
- **Monthly:** on the first scan day of the month.

### 10.2 Opportunity types and categories

| Type | UI category | Default execution |
|---|---|---|
| technical_issue, schema | Technical | github_pr |
| existing_page_optimisation, metadata, internal_linking, ctr_improvement, ranking_opportunity, cro_improvement | On-page | github_pr |
| new_service_page, new_location_page, content_gap, blog_content, competitor_gap | Content | github_pr |
| link_opportunity | Links | outreach_draft (Phase 9+; until then manual_action) |
| gbp_improvement, local_visibility, review_opportunity | Local | gbp_api if the field is supported and low risk, otherwise manual_action |

Detection is **deterministic rules over stored data**. Each rule emits candidates with structured evidence. Examples:

- position 4–15 with meaningful impressions → ranking_opportunity
- a priority service with no dedicated page → new_service_page
- a served location with no page, but proven local search demand → new_location_page

The LLM only writes the human-readable text from that evidence.

### 10.3 Evidence requirement

**Every** recommendation carries at least one evidence item: `{ source, metric, value, period, url?, note }`. A recommendation without evidence is never shown. Generic tasks ("Write a blog") are forbidden. The text must explain what, why, the evidence, the expected benefit and the execution.

### 10.4 Deduplication and suppression

- `fingerprint = sha256(client_id | type | normalised target_url | normalised target_query | action_key)`
- If a candidate matches an existing fingerprint, update `last_detected_at` and the evidence. Don't create a new row.
- **Declined:** suppressed for 90 days. It reappears only if the evidence changes materially (a new `evidence_hash` **and** the score rises by at least 15) or its severity is critical.
- **Deferred:** returns to the candidate pool after `deferred_until`.
- **Completed:** never recreated unless new evidence describes a different, meaningful opportunity (which would have a different action key).
- **Stale:** a candidate not detected in 2 consecutive scans is marked stale and removed from the backlog.

### 10.5 Scoring, weighting and selection

Scoring is **deterministic and configurable**. The scoring config is stored in the DB, never hard-coded. Default:

```
priority = impact × commercial_value × confidence × strategic_relevance / (effort × risk)
```

The result is normalised to 0–100. Strategic relevance is boosted for priority services and for keywords the client has set. `impact_label` comes from score thresholds (High ≥ 80, Medium ≥ 65, otherwise Low; configurable).

**Selection, each scan:**

1. Drop anything below `min_score`, and anything that violates the strategy guards (services and locations not on the client's lists, or on the excluded lists).
2. **Critical technical issues** (e.g. site-wide noindex, broken homepage, sitemap missing) bypass the weighting and always appear first.
3. Fill up to `recs_per_scan` (default 10). Category weights act as **preferences, not quotas**: they break ties and shape the mix, but never force low-value work in.
4. Show fewer than the target if there aren't enough good opportunities. **Never pad the list.**
5. Leftover qualifying candidates become `reserve`, and the backlog persists between scans.

**Default weights** (global, overridable per client):

| Category | Weight |
|---|---|
| Technical | 25 |
| Existing pages | 20 |
| New pages | 20 |
| Local/GBP | 15 |
| Content | 10 |
| Internal links | 5 |
| Authority/links | 5 |

The Auto/Custom UI comes in Phase 9. Until then, use Auto with these weights.

**Workspace limits:** at most 6 new pages per client per month, excluding blog posts (which have their own commitment).

**Safety rules (never automatic, always manual_action):**

- page deletion
- redirects
- domain changes
- major architecture changes
- `robots.txt` changes
- GBP name, address, primary category or phone changes

### 10.6 Blog commitment

The tier's `posts_per_month` (N) is a **promise to the client**. Every month the client gets exactly N published posts.

- **On the 1st of the month** (after reports), create a `blog_commitments` row and plan **N topics**.
  - Start with the best content opportunities (blog_content, content_gap) for the client.
  - If there are fewer than N strong ones, derive topics from real demand data: question-style queries from SiteGuru keywords, competitor coverage from the SERP data, and seasonal relevance for the business type.
  - **Every topic carries evidence.** Never invent a topic with no demand signal.
- **Drafts are spread across the month.** Generate them in weekly waves so they don't all land at once (e.g. N=4 → one per week).
- **Each draft** goes through: brief → draft → quality check. The quality check rejects drafts that are thin, duplicate existing pages, keyword-stuff, or contain unverifiable claims, credentials or testimonials. Only the client's services and locations may be used.
- **If "Review blog posts" is ON:** the draft appears as a Content recommendation with a preview, and approving it adds it to a batch as normal.
- **If it's OFF:** the draft is auto-approved into an automatic batch. It still goes through a PR, which still needs merging.
- **Progress** shows in the client header: "Posts this month: x of N". A post counts when it's live.
- **Behind schedule** means that in the final 7 days of the month, fewer than N posts are approved. Create an attention item and turn the header text yellow.
- Blog posts **don't count** toward `recs_per_scan` or the new-pages limit.

---

## 11. Execution

### 11.1 Batches and the undo window

**When the operator taps Approve** (server action):

1. The client generates an `idempotency_key` (UUID) and sends it with the action.
2. In one transaction:
   - Create the batch: `status = pending_start`, `starts_at = now + undo_window`.
   - Set the opportunities to `approved`, with `decided_at`, `decided_by` and `batch_id`.
   - Create `executions` rows (status `queued`).
   - Write the audit log.
3. Send the Inngest event `batch.approved`.

**Undo / Cancel batch** works only while the batch is `pending_start`. It sets the batch to `cancelled`, cancels the executions, and returns the opportunities to `recommended`.

**`batch.dispatch` (Inngest):**

1. `step.sleepUntil(starts_at)`.
2. Re-read the batch. If it isn't still `pending_start`, exit.
3. Set it to `running`.
4. Split the executions by type:
   - **github_pr** → one GitHub job for the whole batch (§11.2)
   - **gbp_api** → one step per change (§11.3)
   - **manual_action** → an attention item with a checklist, execution status `action_needed`

**Concurrency:** at most **one running GitHub job per client** (Inngest concurrency key = `client_id`). Later batches wait their turn. Each job branches from the latest default branch. If a PR conflicts with an earlier unmerged PR, mark it Action needed rather than trying to rebase automatically.

**Auto-approved batches** (low-impact fixes, or blog drafts with review off) use the same pipeline with `created_by = auto` and no undo window.

### 11.2 Website changes: Claude Code in GitHub Actions

**Client repo setup.** The setup PR from onboarding adds two things from `templates/client-repo/`:

- `.github/workflows/seo-autopilot.yml`, triggered by `workflow_dispatch` with inputs `batch_id` and `spec_url`
- `.seo-autopilot/qa.mjs`, the SEO QA script, versioned

`ANTHROPIC_API_KEY` and `SEO_AUTOPILOT_CALLBACK_SECRET` are set as **organisation-level** Actions secrets, once.

**Dispatch:**

1. The app creates a `github_jobs` row and a **one-time callback token** (stored hashed, expires in 2h).
2. It calls `workflow_dispatch` on the default branch with `batch_id` and `spec_url` (`{APP_URL}/api/github-callback/spec/{batch_id}`).

**The workflow:**

1. Checks out the repo and creates the branch `seo-autopilot/batch-{short_id}`.
2. Fetches the batch spec from `spec_url`, using the token (sent as a header from a secret-derived HMAC).
3. **The spec contains:** the client's strategy (services, locations, exclusions, tone), each recommendation (title, proposed action, target URL, evidence, acceptance criteria), the fixed guardrails below, and, for blog posts, the approved draft content.
4. Runs **Claude Code** via the official Claude Code GitHub Action (or the CLI in headless mode; check the current docs). It works through the recommendations one at a time, making **one commit per recommendation**: `seo: {title} [{opportunity_ref}]`. If the repo has its own `CLAUDE.md`, Claude Code follows it.
5. Runs `lint` (if present), `next build`, then `node .seo-autopilot/qa.mjs`.
6. **If everything passes:** pushes the branch and opens a PR.
   - PR title: "SEO Autopilot: {n} changes ({date})".
   - PR body: each change, its evidence summary, the QA results, and a link back to the app.
7. **Callbacks** to `{APP_URL}/api/github-callback/{batch_id}` at each stage: `started`, `item_done`, `qa_result`, `pr_opened`, `failed`. Each is HMAC-signed and carries an idempotency key per event.
8. **On any failure:** no PR is opened. A `failed` callback is sent with the step and log excerpt. The failure shows as Failed in the app with Retry.

**Fixed guardrails, included in every spec:**

- Only change files needed for the listed recommendations.
- Never delete routes, add redirects, edit `robots`, or change `next.config` redirects or rewrites, unless the recommendation explicitly says so. Such recommendations are manual anyway.
- Never add `noindex`.
- Never invent services, locations, prices, reviews, testimonials, credentials or statistics.
- Match the existing code style and components. Use Next.js Metadata API conventions.
- If a recommendation can't be implemented safely, skip it and report why. Don't improvise.

**SEO QA checks** (`qa.mjs`, run against the build output and the diff):

- the build succeeds
- no routes removed compared with the base branch
- no new `noindex` or `nofollow`
- canonicals present and self-referencing on changed and new pages
- title and meta description present, unique, and within sensible lengths
- internal links in changed files resolve to existing routes
- new pages included in the sitemap
- `robots.txt` unchanged
- JSON-LD parses and has the expected `@type`
- no new redirects
- diff size under the threshold (default 1,500 changed lines; over it means failure)
- no near-duplicate content between new pages and existing ones (simple shingle similarity, under 0.8)

**Reconciliation (`github.reconcile`, every 10 minutes):** for jobs that are `running` and have had no callback for 15 minutes, check the workflow run via the GitHub API and sync its state. If a job has been running longer than 60 minutes, mark it failed with a timeout.

**After the PR:**

- The PR appears as "PR ready", plus a "PR to review" attention item.
- **PR merged** (webhook) → `merged` → **`deployment.verify`**: poll the live target URLs every 2 minutes for up to 30 minutes. Pass if each returns 200, is indexable, and shows the expected title and meta (or, for a new page, exists). Pass → `live`. Fail → Action needed.
- **PR closed without merging** → executions go back to `recommended`, with the note "PR closed without merging".

**Retry** creates a new execution attempt with a new idempotency key on a fresh branch. Never reuse a failed branch.

### 11.3 GBP changes

**Flow:** approved → read the current value (before) → submit → `submitted` → re-read → `verified`, or `verification_pending` with re-checks (§9.3).

Unsupported or high-risk changes are always `manual_action_required`, shown as an attention item with step-by-step instructions and the exact proposed value to copy.

---

## 12. Scheduled jobs (Inngest, Europe/London)

| Job | When | Notes |
|---|---|---|
| `scan.schedule` | Workspace scan day/time (default Mon 06:00) | Fans out `client.scan` for clients due by tier cadence |
| `client.scan` | Event | §10.1. Concurrency 1 per client. |
| `batch.dispatch` | Event | §11.1 |
| `github.reconcile` | Every 10 min | §11.2 |
| `gbp.verify` | Every 6 h | Pending GBP changes |
| `siteguru.sync.daily` | Daily 05:00 | Refreshes KPIs for the dashboard and Reports tab |
| `report.monthly` | 1st of month, 07:00 | For each active client with "Include in monthly report" on |
| `blog.plan` | 1st of month, 08:00 | §10.6 |
| `blog.draft_wave` | Weekly, after scan | Drafts the next scheduled post(s) |
| `blog.commitment_check` | Daily | Behind-schedule attention items |
| `attention.digest` | Weekly, Mon 08:00 | Only if the weekly digest is on |
| `results.measure` | Daily | Phase 9: 28/56-day outcome measurement |

Every job:

- is idempotent
- writes an `automation_runs` row
- retries with backoff (Inngest defaults, at most 3)
- on final failure, creates an attention item and a Slack alert

**Never fail silently.**

### 12.1 Monthly report (`report.monthly`)

**Data:** SiteGuru metrics for the previous calendar month vs the month before; GBP performance; the SERP local ranking change; and completed work. Completed work means executions that went `live` in the month, plus verified GBP changes, plus published blog posts.

The **numbers are computed by code**. The LLM writes the summary and bullets from those numbers and the work list. It must follow the tone rules:

- positive, confident, plain English, non-technical
- **never hide or spin a decline:** state it, give context, and say what's being done
- only include metrics that are verified and available

The output follows the mock's structure:

- greeting
- summary
- **What we did** (simple bullets a business owner understands, e.g. "Created a new Emergency Plumbing page")
- **How it performed**
- **Next month** (3–5 bullets from the top reserve/backlog items)
- sign-off

Generate `email_text` and `email_html` at the same time. The subject line is "{Month} SEO update — {Client}". Then create a "Report ready" attention item and send a Slack notification.

---

## 13. Environment variables

```
APP_URL
DATABASE_URL                       Neon pooled connection string
DATABASE_URL_UNPOOLED              for migrations
SESSION_SECRET                     32+ random bytes
ADMIN_EMAIL
ADMIN_PASSWORD_HASH
ENCRYPTION_KEY                     32 bytes, base64 (tokens, webhook URLs)
INNGEST_EVENT_KEY
INNGEST_SIGNING_KEY
ANTHROPIC_API_KEY
ANTHROPIC_MODEL
SITEGURU_API_KEY                   or MCP credentials, per Phase 3 findings
GITHUB_APP_ID
GITHUB_APP_SLUG
GITHUB_APP_PRIVATE_KEY
GITHUB_APP_WEBHOOK_SECRET
GITHUB_CALLBACK_SECRET             HMAC for workflow callbacks (same value as the org secret)
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
DATAFORSEO_LOGIN
DATAFORSEO_PASSWORD
```

Provide `.env.example` with every variable and a one-line comment for each.

**Vercel notes:**

- Use Vercel **Pro**, since this is commercial use and needs longer function durations.
- Register Inngest via the Vercel integration, serving at `/api/inngest`.
- Run migrations in a build step against `DATABASE_URL_UNPOOLED`.
- Use Neon branching for preview deployments if it's easy to set up; otherwise point previews at a separate dev database.

---

## 14. Build phases

Finish each phase, deploy it, and check its acceptance criteria before starting the next.

### Phase 1 — Foundation and UI shell
- Next.js, Tailwind tokens, Inter, the shared primitives (§6.2), and responsive layout (§6.3) with the PWA manifest.
- Auth and the login page (§5).
- Drizzle schema, migrations, the seed script with the mock's data, audit log helpers, Inngest wiring, attention items.
- **Every screen from §7**, built against the database with seeded data.
- A **FakeExecutor** that simulates execution statuses (queued → running → PR ready → live) so the approval loop can be tested end to end.

**Acceptance:**
- It deploys to Vercel with Neon.
- Login works, and so does rate limiting.
- Every screen matches the mock at 1280px and works well at 375px.
- Approve → toast → Undo works.
- Approve → wait out the undo window → the FakeExecutor moves the statuses along, as seen in the Actioned tab.
- Duplicate approve submissions create one batch.
- Autosave persists, and every change appears in the Activity log.

### Phase 2 — Onboarding and GitHub App
- GitHub App install flow, repo picker, and the onboarding steps in §9.1 (excluding SERP).
- Setup PR with the workflow and QA templates.
- Discovery of services and locations; Confirm and activate.

**Acceptance:** adding a real client produces a setup PR and lands in "Confirm details" with sensible discovered services and locations.

### Phase 3 — SiteGuru
- Confirm the access method and record the findings in `docs/integrations/siteguru.md`.
- Provider, syncs, snapshots, integration health.
- Real data in the dashboard and the Reports tab.
- Answer the GA4 conversions question.

**Acceptance:** the test client shows real KPIs, top pages and top keywords. A sync failure appears in Integrations and in Needs attention.

### Phase 4 — Opportunity engine
- Detection rules over SiteGuru data and the page inventory, scoring, fingerprinting, suppression, backlog, selection, LLM text, tier-cadence scheduling.

**Acceptance:**
- A scheduled scan produces evidence-backed recommendations for the test client.
- Re-running the scan doesn't duplicate them.
- Declined items stay suppressed.

### Phase 5 — Claude Code execution
- Replace the FakeExecutor with the GitHub provider: dispatch, spec endpoint, callbacks, QA, PR, merge webhook, production verification, reconciliation, retry.

**Acceptance:**
- A low-risk batch goes from Approve to a working PR with passing QA. Merging it results in Live.
- A deliberately failing QA produces Failed plus an attention item and no PR.
- A duplicate webhook or callback is harmless.

### Phase 6 — Google Business Profile
- OAuth, read operations, Local opportunities, supported write operations with before/after records, verification, and manual instructions for everything else.

**Acceptance:** a supported GBP change goes from Approve to Verified, and an unsupported one becomes a clear manual checklist.

### Phase 7 — SERP intelligence
- DataForSEO provider, tracked queries, local visibility table, competitor discovery, content-gap evidence.

**Acceptance:** the Reports tab shows local pack positions per service and town, and new Content and Local opportunities cite SERP evidence.

### Phase 8 — Monthly reports and blog commitment
- `report.monthly`, the report document, copy for email (text + HTML), Mark as sent.
- Blog planning, drafting waves, quality checks, commitment tracking.

**Acceptance:**
- On the 1st, a report with only verified metrics and a plain-English work summary appears for each client.
- Each client's N blog posts are planned and drafted through the month.
- Falling behind raises an attention item.

### Phase 9 — Learning and weighting
- `opportunity_results` (28/56-day measurement, stored as correlations with confidence, never as claims of causation).
- Auto/Custom weighting UI, global and per client.
- Results feeding back into confidence scoring.
- Link outreach drafts.

**Later (not in scope now):** Gmail draft creation for reports, optional automatic sending per client, web push notifications, a direct GA4 conversions connector (if Phase 3 says it's needed).

---

## 15. Things to verify during the build (report back, don't guess)

1. **SiteGuru:** how programmatic access works (REST vs MCP), authentication, rate limits, how much history is available, and whether GA4 conversions are exposed.
2. **Google Business Profile:** API access approval status, and exactly which fields can be written.
3. **Claude Code GitHub Action:** the current inputs, authentication and recommended headless usage.
4. **DataForSEO:** the cost per client per month at 30 tracked queries on a weekly cadence. Flag it if it's above £20 per client.
5. **Inngest on Vercel:** that the plan limits fit the job volume for about 10 clients.
