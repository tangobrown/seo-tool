# SiteGuru integration: findings (Phase 3)

Checked on 4 Oct 2026 against the live SiteGuru MCP server, through an authenticated connection, plus SiteGuru's own docs ([MCP setup](https://www.siteguru.co/seo-academy/siteguru-mcp-setup)).

## Access method

- **MCP over Streamable HTTP** at `https://mcp.siteguru.co/mcp`. We didn't find a separate public REST API, so the app uses the MCP server.
- **Auth:** an API key sent as `Authorization: Bearer <key>`. Keys are created and revoked on SiteGuru's *API access* page, which also shows when each key was last used. OAuth is the other option, but it needs a person to click Allow, so it doesn't suit a scheduled server.
- **Requirements:** a SiteGuru plan that includes MCP access. The key must belong to the account owner, and it sees exactly the sites that account can see.
- **Client:** a minimal MCP client (`src/integrations/mcp/client.ts`, about 150 lines, using `fetch`). No MCP SDK dependency. It handles both JSON and `text/event-stream` responses and reads the `Mcp-Session-Id` header.
- **Where the key comes from:** Settings → Integrations (stored AES-256-GCM encrypted in `integrations.secret_enc`). If none is saved there, the app falls back to `SITEGURU_API_KEY`.

## Rate limits

Not published. A sync makes 5 calls per client per day: the 30-day overview, keywords, and up to 3 monthly overviews. For about 10 clients that's roughly 50 calls a day. The shared wrapper (`callProvider`) handles timeouts, 2 retries with backoff, and integration health.

## Data we use

| Tool | Used for | Notes |
|---|---|---|
| `list_sites` | Onboarding match, the site picker, "Test connection" | `domain` includes scheme and `www.` We match exactly, ignoring both. `data_sources.search_console.connected` says whether GSC figures exist. |
| `get_traffic_overview` (`range: last_30_days`) | KPI strip, dashboard clicks | `search_console.clicks/impressions/ctr` each give `{value, previous, delta_pct}`. **CTR is a percentage** (0.9 = 0.9%). The response also has `top_pages` (20). |
| `get_traffic_overview` (custom `start`/`end`) | Monthly snapshots for the clicks chart | Only works for periods SiteGuru has already cached. Otherwise it returns `status: "empty"` and a link that only works for a signed-in user. |
| `get_top_keywords` (`range: last_30_days`) | Top keywords | `avg_position.change` = current − previous (negative means it moved up). `previous: 0` means it wasn't ranking before; we show no change rather than a bogus jump. **Keyword CTR is a fraction** (0.54 = 54%), not a percentage like the overview's. |

## Gaps (we show "—", we don't estimate)

- **No site-wide average position.** Positions exist only per keyword or per page. The Avg. position KPI shows "—". An impression-weighted average of the top 100 keywords would be an estimate, so we don't calculate one.
- **Search Console not connected in SiteGuru:** no clicks, impressions, CTR, top pages or keywords. Of the 3 sites on the account today, only projuice.co.uk has GSC connected. The fix is to connect GSC inside SiteGuru.
- **History:** the cached ranges are the last 7, 30 and 90 days, ending about 3 days ago (GSC lag). Older months can't be fetched over the API. We store a `month` snapshot for each full calendar month SiteGuru has (up to the last 3, refreshed daily), so the 12-month chart fills in over time. Months with no data show as grey placeholders.

## GA4 conversions question (BUILD_SPEC §9.2)

SiteGuru's analytics block exposes **sessions, users and revenue** (revenue for ecommerce sites only). It has **no conversions or key events**. Following the spec, monthly reports leave conversions out and never estimate them. If conversions are needed later, it would take a minimal direct GA4 connector (listed as "later" in §14).

## Sync

- `siteguru-sync-daily`: 05:00 Europe/London. It fans out one `siteguru.sync.client` event per linked, active, non-paused client. The event ID is per day, so a re-run doesn't double up.
- `siteguru-sync-client`: concurrency 1 per client, 3 retries. It writes a `rolling30` snapshot and any available `month` snapshots (upserted on a unique index), and updates the client's SiteGuru connection.
- **On failure:** the connection is set to `error` with the message, and one attention item "SiteGuru sync failing for N clients" is raised. It resolves itself once nothing is failing. Slack is notified after the final retry.
- **Other triggers:** onboarding (match, then first sync), linking a site in Connections, and "Sync now".
- The UI only ever reads `metric_snapshots`. It never calls SiteGuru when a page loads.

## Not yet used (later phases)

`get_todo_list`, `get_seo_report`, `get_low_hanging_fruit`, `get_declining_content`, `get_keyword_cannibalization`, `get_search_topics` and the backlink/competitor tools feed the opportunity engine (Phase 4) and monthly reports (Phase 8).
