import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { clients, integrations, metricSnapshots, siteAudits, workspace } from "@/db/schema";
import { auditToTodo } from "@/domain/audit";
import { bareDomain, isClientDomain, trackedQueries, type SerpResult } from "@/domain/serp";
import { dataforseo, type SerpItem } from "@/integrations/dataforseo";
import { getProviderKey } from "@/integrations/keys";
import { pagespeed } from "@/integrations/pagespeed";
import { raiseAttention, resolveAttention } from "@/lib/attention";

export const AUDIT_MAX_PAGES = 500;

export async function dataforseoConfigured(): Promise<boolean> {
  return !!(await getProviderKey("dataforseo"));
}

// ── Site audit ───────────────────────────────────────────────────────────────

/** Starts a crawl unless one is already running for this client. Returns the audit row id. */
export async function startSiteAudit(clientId: string): Promise<{ auditId: string; started: boolean }> {
  const [running] = await db
    .select({ id: siteAudits.id })
    .from(siteAudits)
    .where(and(eq(siteAudits.clientId, clientId), eq(siteAudits.status, "crawling")))
    .orderBy(desc(siteAudits.startedAt))
    .limit(1);
  if (running) {
    const [r] = await db.select().from(siteAudits).where(eq(siteAudits.id, running.id));
    // A crawl still "running" after a day was lost; give up on it and start again.
    if (r && Date.now() - r.startedAt.getTime() < 24 * 3600_000) return { auditId: running.id, started: false };
    await db.update(siteAudits).set({ status: "failed", finishedAt: new Date(), error: "Crawl didn’t finish within 24 hours" }).where(eq(siteAudits.id, running.id));
  }
  const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!c) throw new Error(`Client ${clientId} not found`);
  const task = await dataforseo.startAudit(bareDomain(c.domain), AUDIT_MAX_PAGES, `audit:${clientId}`);
  const [row] = await db
    .insert(siteAudits)
    .values({ clientId, taskId: task.id, costUsd: task.cost })
    .onConflictDoNothing({ target: siteAudits.taskId })
    .returning({ id: siteAudits.id });
  return { auditId: row!.id, started: true };
}

/**
 * Collects a finished crawl into to-do items. Returns "crawling" while DataForSEO is still going.
 * A crawl DataForSEO couldn't do (site unreachable, robots.txt block) fails visibly.
 */
export async function collectSiteAudit(auditId: string): Promise<"crawling" | "finished" | "failed"> {
  const [a] = await db.select().from(siteAudits).where(eq(siteAudits.id, auditId));
  if (!a) throw new Error(`Audit ${auditId} not found`);
  if (a.status !== "crawling") return a.status as "finished" | "failed";
  const [c] = await db.select().from(clients).where(eq(clients.id, a.clientId));
  const summary = await dataforseo.auditSummary(a.taskId);
  if (!summary || summary.crawl_progress !== "finished") return "crawling";

  const crawlStatus = summary.domain_info?.extended_crawl_status;
  if (crawlStatus && crawlStatus !== "no_errors") {
    const error = `The site couldn’t be crawled (${crawlStatus.replace(/_/g, " ")})`;
    await db.update(siteAudits).set({ status: "failed", finishedAt: new Date(), error, summary: summary as Record<string, unknown> }).where(eq(siteAudits.id, auditId));
    await raiseAttention({
      dedupeKey: `audit_failed:${a.clientId}`,
      kind: "integration",
      clientId: a.clientId,
      title: `Site audit failed for ${c?.name ?? "a client"}`,
      detail: `${error}. Technical recommendations use the last successful audit until this is fixed.`,
      link: `/clients/${a.clientId}/settings`,
    });
    return "failed";
  }

  const [pagesList, links, nonIndexable] = await Promise.all([
    dataforseo.auditPages(a.taskId),
    dataforseo.auditProblemLinks(a.taskId),
    dataforseo.auditNonIndexable(a.taskId),
  ]);

  // Mobile speed for the homepage and the pages that earn the most clicks (free Google API).
  const [snap] = await db
    .select({ metrics: metricSnapshots.metrics })
    .from(metricSnapshots)
    .where(and(eq(metricSnapshots.clientId, a.clientId), eq(metricSnapshots.source, "gsc"), eq(metricSnapshots.kind, "rolling30")))
    .orderBy(desc(metricSnapshots.capturedAt))
    .limit(1);
  const base = c?.websiteUrl ?? `https://${c?.domain}`;
  const speedPaths = [...new Set(["/", ...(snap?.metrics.topPages ?? []).map((p) => p.path)])].slice(0, 5);
  const speed: { url: string; score: number | null; lcpMs: number | null }[] = [];
  for (const path of speedPaths) {
    try {
      speed.push(await pagespeed.run(new URL(path, base).toString()));
    } catch (e) {
      console.error("PageSpeed failed", path, e);
    }
  }

  const todo = auditToTodo({
    pages: pagesList,
    brokenLinks: links.broken,
    linksToRedirects: links.toRedirect,
    nonIndexable,
    domainChecks: summary.domain_info?.checks ?? {},
    speed,
  });
  await db
    .update(siteAudits)
    .set({
      status: "finished",
      finishedAt: new Date(),
      pagesCrawled: summary.crawl_status?.pages_crawled ?? pagesList.length,
      todo: todo as Record<string, unknown>[],
      summary: { ...(summary as Record<string, unknown>), speed },
    })
    .where(eq(siteAudits.id, auditId));
  await resolveAttention(`audit_failed:${a.clientId}`);
  return "finished";
}

/** To-do items from the client's latest finished audit, or null if there's never been one. */
export async function latestAuditTodo(clientId: string) {
  const [a] = await db
    .select({ todo: siteAudits.todo })
    .from(siteAudits)
    .where(and(eq(siteAudits.clientId, clientId), eq(siteAudits.status, "finished")))
    .orderBy(desc(siteAudits.finishedAt))
    .limit(1);
  return (a?.todo ?? null) as import("@/domain/opportunities/types").Signals["todo"] | null;
}

// ── Local search tracking ────────────────────────────────────────────────────

type LocationCache = Record<string, number | null>;

/**
 * Town name → DataForSEO location code, cached in the integrations row. A town DataForSEO doesn't
 * know is cached as null and skipped (reported), never guessed.
 */
export async function resolveLocations(towns: string[]): Promise<Record<string, number | null>> {
  const [row] = await db.select({ config: integrations.config }).from(integrations).where(eq(integrations.provider, "dataforseo"));
  const cache = ((row?.config ?? {}) as { locations?: LocationCache }).locations ?? {};
  const key = (t: string) => t.trim().toLowerCase();
  const missing = towns.filter((t) => !(key(t) in cache));
  if (missing.length) {
    const all = await dataforseo.ukLocations();
    for (const t of missing) {
      const prefix = `${key(t)},`;
      const hit = all.find((l) => l.location_type === "City" && l.location_name.toLowerCase().startsWith(prefix));
      cache[key(t)] = hit?.location_code ?? null;
    }
    await db
      .update(integrations)
      .set({ config: { ...((row?.config ?? {}) as Record<string, unknown>), locations: cache } })
      .where(eq(integrations.provider, "dataforseo"));
  }
  return Object.fromEntries(towns.map((t) => [t, cache[key(t)] ?? null]));
}

export type PostedSerp = { tag: string; kind: "organic" | "maps"; id: string; query: string; service: string; location: string };

/** Posts this client's tracked searches (organic + Maps) to the queue. */
export async function postClientSerp(clientId: string): Promise<{ posted: PostedSerp[]; unknownTowns: string[]; cost: number }> {
  const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!c) throw new Error(`Client ${clientId} not found`);
  const [ws] = await db.select({ cap: workspace.serpQueryCap }).from(workspace).where(eq(workspace.id, 1));
  const queries = trackedQueries(c, ws?.cap ?? 30);
  if (!queries.length) return { posted: [], unknownTowns: [], cost: 0 };
  const codes = await resolveLocations([...new Set(queries.map((q) => q.location))]);
  const unknownTowns = Object.entries(codes).filter(([, v]) => v == null).map(([k]) => k);
  const ready = queries.filter((q) => codes[q.location] != null);
  const specs = ready.flatMap((q) =>
    (["organic", "maps"] as const).map((kind) => ({ kind, keyword: q.query, locationCode: codes[q.location]!, tag: `${kind}:${clientId}:${q.query}`.slice(0, 255) })),
  );
  const res = await dataforseo.postSerpTasks(specs);
  const byTag = new Map(ready.flatMap((q) => (["organic", "maps"] as const).map((kind) => [`${kind}:${clientId}:${q.query}`.slice(0, 255), q])));
  const posted = res.ids.flatMap((x) => {
    const q = byTag.get(x.tag);
    return x.id && q ? [{ tag: x.tag, kind: x.kind, id: x.id, query: q.query, service: q.service, location: q.location }] : [];
  });
  if (unknownTowns.length) {
    await raiseAttention({
      dedupeKey: `serp_towns:${clientId}`,
      kind: "integration",
      clientId,
      title: `Rankings can’t be checked for ${unknownTowns.join(", ")}`,
      detail: "Google’s location list doesn’t have these towns under that name. Use the nearest town’s usual name in the client’s locations.",
      link: `/clients/${clientId}/settings`,
    });
  } else {
    await resolveAttention(`serp_towns:${clientId}`);
  }
  return { posted, unknownTowns, cost: res.cost };
}

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Combines an organic and a Maps result for one search into a SerpResult. */
export function toSerpResult(q: { query: string; service: string; location: string }, client: { domain: string; name: string }, organic: SerpItem[], maps: SerpItem[]): SerpResult {
  const org = organic
    .filter((i) => i.type === "organic" && i.rank_group != null)
    .map((i) => ({ position: i.rank_group!, domain: bareDomain(i.domain), url: i.url ?? "", title: i.title ?? "" }))
    .sort((a, b) => a.position - b.position);
  const local = maps
    .filter((i) => i.type === "maps_search" && i.rank_group != null)
    .map((i) => ({ position: i.rank_group!, title: i.title ?? "", domain: i.domain ? bareDomain(i.domain) : null, rating: i.rating?.value ?? null }))
    .sort((a, b) => a.position - b.position);
  const mine = org.find((o) => isClientDomain(o.domain, client.domain));
  const mineLocal = local.find((l) => isClientDomain(l.domain, client.domain) || (norm(l.title) !== "" && norm(l.title) === norm(client.name)));
  return {
    ...q,
    organicPosition: mine?.position ?? null,
    organicUrl: mine?.url ?? null,
    localPosition: mineLocal?.position ?? null,
    organic: org.slice(0, 10),
    local: local.slice(0, 10),
  };
}

/**
 * Fetches posted searches. Returns the searches with both halves ready, and the ones still queued.
 * A search with one failed half is still reported using what came back.
 */
export async function collectClientSerp(clientId: string, posted: PostedSerp[]): Promise<{ results: SerpResult[]; pending: PostedSerp[]; failed: number }> {
  const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!c) throw new Error(`Client ${clientId} not found`);
  const got = new Map<string, SerpItem[] | null>(); // tag → items (null = failed)
  const pending: PostedSerp[] = [];
  let failed = 0;
  for (const p of posted) {
    const r = await dataforseo.getSerpTask(p.kind, p.id);
    if (r.status === "pending") pending.push(p);
    else if (r.status === "failed") {
      got.set(p.tag, null);
      failed++;
    } else got.set(p.tag, r.items);
  }
  const results: SerpResult[] = [];
  const queries = new Map(posted.map((p) => [p.query, p]));
  for (const [query, p] of queries) {
    const o = got.get(`organic:${clientId}:${query}`.slice(0, 255));
    const m = got.get(`maps:${clientId}:${query}`.slice(0, 255));
    if (o === undefined || m === undefined) continue; // a half is still queued
    if (o === null && m === null) continue;
    results.push(toSerpResult({ query, service: p.service, location: p.location }, c, o ?? [], m ?? []));
  }
  return { results, pending, failed };
}
