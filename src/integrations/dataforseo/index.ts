import "server-only";
import { z } from "zod";
import { getProviderKey } from "../keys";
import { callProvider, IntegrationError } from "../run";

// DataForSEO over its REST API (Basic auth). Standard queue for SERPs and the On-Page crawler:
// we post tasks, the job sleeps, then collects results. Schemas are lenient on purpose: the
// published spec marks every field nullable.

const API = "https://api.dataforseo.com/v3";

/** Task status codes meaning "not finished yet" (40601 handed, 40602 in queue). */
const NOT_READY = new Set([40601, 40602]);
/** No results for these parameters. Billed, but not an error for us. */
const NO_RESULTS = 40102;

const taskSchema = z.object({
  id: z.string().nullish(),
  status_code: z.number(),
  status_message: z.string().nullish(),
  cost: z.number().nullish(),
  data: z.record(z.string(), z.unknown()).nullish(),
  result: z.array(z.unknown()).nullish(),
});
const envelopeSchema = z.object({
  status_code: z.number(),
  status_message: z.string().nullish(),
  cost: z.number().nullish(),
  tasks: z.array(taskSchema).nullish(),
});
type Task = z.infer<typeof taskSchema>;

async function authHeader(): Promise<string> {
  const creds = await getProviderKey("dataforseo");
  if (!creds) throw new IntegrationError("dataforseo", "No DataForSEO login. Add it in Settings → Integrations.", false);
  return `Basic ${Buffer.from(creds).toString("base64")}`;
}

async function call(op: string, path: string, body?: unknown, opts: { timeoutMs?: number } = {}): Promise<{ cost: number; tasks: Task[] }> {
  const auth = await authHeader();
  return callProvider(
    "dataforseo",
    op,
    async (signal) => {
      const res = await fetch(`${API}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      if (res.status === 401) throw new IntegrationError("dataforseo", "DataForSEO rejected the login. Check the API login and password.", false);
      if (!res.ok) throw new IntegrationError("dataforseo", `DataForSEO ${res.status}`, res.status >= 500 || res.status === 429);
      const env = envelopeSchema.parse(await res.json());
      if (env.status_code === 40200 || env.status_code === 40210) throw new IntegrationError("dataforseo", "DataForSEO balance is empty. Top up your account.", false);
      if (env.status_code !== 20000) throw new IntegrationError("dataforseo", `DataForSEO ${env.status_code}: ${env.status_message ?? ""}`, env.status_code >= 50000);
      return { cost: env.cost ?? 0, tasks: env.tasks ?? [] };
    },
    { timeoutMs: opts.timeoutMs ?? 60_000 },
  );
}

function firstResult(t: Task | undefined): unknown {
  return t?.result?.[0];
}

// ── Locations ────────────────────────────────────────────────────────────────

const locationSchema = z.object({
  location_code: z.number(),
  location_name: z.string(),
  location_type: z.string().nullish(),
  country_iso_code: z.string().nullish(),
});
export type DfsLocation = z.infer<typeof locationSchema>;

// ── SERP results ─────────────────────────────────────────────────────────────

const ratingSchema = z.object({ value: z.number().nullish() }).nullish();
const serpItemSchema = z
  .object({
    type: z.string(),
    rank_group: z.number().nullish(),
    rank_absolute: z.number().nullish(),
    domain: z.string().nullish(),
    url: z.string().nullish(),
    title: z.string().nullish(),
    rating: ratingSchema,
    cid: z.string().nullish(),
  })
  .passthrough();
const serpResultSchema = z.object({ keyword: z.string().nullish(), items: z.array(serpItemSchema).nullish() });
export type SerpItem = z.infer<typeof serpItemSchema>;

export type SerpTaskSpec = { kind: "organic" | "maps"; keyword: string; locationCode: number; tag: string };
export type SerpTaskResult = { status: "ready"; items: SerpItem[] } | { status: "pending" } | { status: "failed"; error: string };

// ── On-Page ──────────────────────────────────────────────────────────────────

const summarySchema = z.object({
  crawl_progress: z.string().nullish(),
  crawl_status: z.object({ pages_crawled: z.number().nullish(), max_crawl_pages: z.number().nullish() }).nullish(),
  crawl_stop_reason: z.string().nullish(),
  domain_info: z
    .object({
      extended_crawl_status: z.string().nullish(),
      total_pages: z.number().nullish(),
      checks: z.record(z.string(), z.boolean().nullable()).nullish(),
    })
    .passthrough()
    .nullish(),
  page_metrics: z
    .object({
      non_indexable: z.number().nullish(),
      broken_links: z.number().nullish(),
      duplicate_title: z.number().nullish(),
      duplicate_description: z.number().nullish(),
      onpage_score: z.number().nullish(),
      checks: z.record(z.string(), z.number().nullable()).nullish(),
    })
    .passthrough()
    .nullish(),
});
export type AuditSummary = z.infer<typeof summarySchema>;

const pageItemSchema = z
  .object({
    resource_type: z.string().nullish(),
    url: z.string().nullish(),
    status_code: z.number().nullish(),
    checks: z.record(z.string(), z.boolean().nullable()).nullish(),
    meta: z
      .object({
        title: z.string().nullish(),
        description: z.string().nullish(),
        canonical: z.string().nullish(),
        htags: z.record(z.string(), z.array(z.string()).nullable()).nullish(),
        inbound_links_count: z.number().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();
export type AuditPage = z.infer<typeof pageItemSchema>;

const linkItemSchema = z
  .object({
    type: z.string().nullish(),
    page_from: z.string().nullish(),
    link_to: z.string().nullish(),
    direction: z.string().nullish(),
    is_broken: z.boolean().nullish(),
    page_to_status_code: z.number().nullish(),
  })
  .passthrough();
export type AuditLink = z.infer<typeof linkItemSchema>;

const nonIndexableSchema = z.object({ reason: z.string().nullish(), url: z.string().nullish() });

function itemsOf<T>(t: Task | undefined, schema: z.ZodType<T>): T[] {
  const r = firstResult(t) as { items?: unknown[] } | undefined;
  return (r?.items ?? []).flatMap((x) => {
    const p = schema.safeParse(x);
    return p.success ? [p.data] : [];
  });
}

export const dataforseo = {
  /** Account balance; used by "Test connection". */
  async userData(): Promise<{ login: string | null; balance: number }> {
    const { tasks } = await call("user_data", "/appendix/user_data");
    const r = firstResult(tasks[0]) as { login?: string; money?: { balance?: number } } | undefined;
    return { login: r?.login ?? null, balance: r?.money?.balance ?? 0 };
  },

  /** UK locations for Google searches (towns are location_type "City"). Large; callers cache it. */
  async ukLocations(): Promise<DfsLocation[]> {
    const { tasks } = await call("locations", "/serp/google/locations/gb", undefined, { timeoutMs: 120_000 });
    return (tasks[0]?.result ?? []).flatMap((x) => {
      const p = locationSchema.safeParse(x);
      return p.success ? [p.data] : [];
    });
  },

  /** Posts organic (mobile, top 20) and Maps (top 20) searches to the standard queue. Returns task ids by tag. */
  async postSerpTasks(specs: SerpTaskSpec[]): Promise<{ cost: number; ids: { tag: string; kind: "organic" | "maps"; id: string | null; error?: string }[] }> {
    let cost = 0;
    const ids: { tag: string; kind: "organic" | "maps"; id: string | null; error?: string }[] = [];
    for (const kind of ["organic", "maps"] as const) {
      const batch = specs.filter((s) => s.kind === kind);
      for (let i = 0; i < batch.length; i += 100) {
        const chunk = batch.slice(i, i + 100);
        const body = chunk.map((s) => ({
          keyword: s.keyword.replace(/%/g, "%25").replace(/\+/g, "%2B"),
          location_code: s.locationCode,
          language_code: "en",
          // Mobile for organic: local-pack ranks are 0 on desktop. Maps returns 20 results on mobile.
          device: kind === "organic" ? "mobile" : "desktop",
          depth: 20,
          tag: s.tag,
        }));
        const res = await call(`${kind}.task_post`, `/serp/google/${kind}/task_post`, body);
        cost += res.cost;
        res.tasks.forEach((t, j) => {
          const tag = String(t.data?.tag ?? chunk[j]?.tag ?? "");
          ids.push(t.status_code === 20100 || t.status_code === 20000 ? { tag, kind, id: t.id ?? null } : { tag, kind, id: null, error: `${t.status_code} ${t.status_message ?? ""}` });
        });
      }
    }
    return { cost, ids };
  },

  async getSerpTask(kind: "organic" | "maps", id: string): Promise<SerpTaskResult> {
    const { tasks } = await call(`${kind}.task_get`, `/serp/google/${kind}/task_get/advanced/${encodeURIComponent(id)}`);
    const t = tasks[0];
    if (!t) return { status: "failed", error: "No task in response" };
    if (NOT_READY.has(t.status_code)) return { status: "pending" };
    if (t.status_code === NO_RESULTS) return { status: "ready", items: [] };
    if (t.status_code !== 20000) return { status: "failed", error: `${t.status_code} ${t.status_message ?? ""}` };
    const r = serpResultSchema.safeParse(firstResult(t) ?? {});
    return { status: "ready", items: r.success ? (r.data.items ?? []) : [] };
  },

  /** Starts a basic site crawl (no JavaScript rendering), capped at maxPages. */
  async startAudit(target: string, maxPages: number, tag: string): Promise<{ id: string; cost: number }> {
    const res = await call("on_page.task_post", "/on_page/task_post", [{ target, max_crawl_pages: maxPages, enable_www_redirect_check: true, tag }]);
    const t = res.tasks[0];
    if (!t?.id || (t.status_code !== 20100 && t.status_code !== 20000)) {
      throw new IntegrationError("dataforseo", `Site audit couldn’t start: ${t?.status_code ?? ""} ${t?.status_message ?? ""}`, false);
    }
    return { id: t.id, cost: t.cost ?? res.cost };
  },

  async auditSummary(id: string): Promise<AuditSummary | null> {
    const { tasks } = await call("on_page.summary", `/on_page/summary/${encodeURIComponent(id)}`);
    const t = tasks[0];
    if (!t || NOT_READY.has(t.status_code)) return null;
    if (t.status_code !== 20000) throw new IntegrationError("dataforseo", `Site audit summary ${t.status_code}: ${t.status_message ?? ""}`, false);
    const r = summarySchema.safeParse(firstResult(t) ?? {});
    return r.success ? r.data : null;
  },

  /** Every crawled HTML page (the crawl is capped, so one or two requests). */
  async auditPages(id: string, max = 1000): Promise<AuditPage[]> {
    const out: AuditPage[] = [];
    for (let offset = 0; offset < max; offset += 1000) {
      const { tasks } = await call("on_page.pages", "/on_page/pages", [{ id, limit: 1000, offset, filters: [["resource_type", "=", "html"]] }]);
      const items = itemsOf(tasks[0], pageItemSchema);
      out.push(...items);
      if (items.length < 1000) break;
    }
    return out;
  },

  /** Internal links that are broken, or that point at a redirect. */
  async auditProblemLinks(id: string): Promise<{ broken: AuditLink[]; toRedirect: AuditLink[] }> {
    const [b, r] = await Promise.all([
      call("on_page.links", "/on_page/links", [{ id, limit: 1000, filters: [["direction", "=", "internal"], "and", ["is_broken", "=", true]] }]),
      call("on_page.links", "/on_page/links", [{ id, limit: 1000, filters: [["direction", "=", "internal"], "and", ["page_to_status_code", ">=", 300], "and", ["page_to_status_code", "<", 400]] }]),
    ]);
    return { broken: itemsOf(b.tasks[0], linkItemSchema), toRedirect: itemsOf(r.tasks[0], linkItemSchema) };
  },

  async auditNonIndexable(id: string): Promise<{ reason: string; url: string }[]> {
    const { tasks } = await call("on_page.non_indexable", "/on_page/non_indexable", [{ id, limit: 1000 }]);
    return itemsOf(tasks[0], nonIndexableSchema).flatMap((x) => (x.url ? [{ reason: x.reason ?? "", url: x.url }] : []));
  },
};
