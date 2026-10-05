import "server-only";
import { and, desc, eq, gte, inArray, lt, or, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { batches, clients, executions, githubJobs, opportunities, webhookEvents, type EvidenceItem } from "@/db/schema";
import { github, githubConfigured } from "@/integrations/github";
import { appLink, notify } from "@/integrations/slack";
import { audit } from "@/lib/audit";
import { raiseAttention, resolveAttention } from "@/lib/attention";
import { hmacSha256, randomToken, safeEqual, sha256 } from "@/lib/crypto";
import { setExecutionStatus } from "./execution";

// Claude Code execution in each client repo's GitHub Actions (§11.2). The contract with the
// workflow is in templates/client-repo/.seo-autopilot (callback.mjs).

const MAX_CLOCK_SKEW_S = 10 * 60;
const TOKEN_TTL_MS = 2 * 3600_000;

export const GUARDRAILS = [
  "Only change files needed for the listed recommendations.",
  "Never delete routes, add redirects, edit robots, or change next.config redirects or rewrites.",
  "Never add noindex or nofollow.",
  "Never invent services, locations, prices, reviews, testimonials, credentials or statistics. Only use the client's services and locations listed in the spec.",
  "Match the existing code style and components. Use Next.js Metadata API conventions for titles, descriptions, canonicals and Open Graph.",
  "If a recommendation can't be implemented safely, skip it and report why. Don't improvise.",
];

export function oppRef(id: string) {
  return `OPP-${id.slice(0, 8)}`;
}

function callbackSecret(): string {
  const s = process.env.GITHUB_CALLBACK_SECRET;
  if (!s) throw new Error("GITHUB_CALLBACK_SECRET is not set");
  return s;
}

function appUrl(): string {
  return (process.env.APP_URL ?? "").replace(/\/$/, "");
}

/** Verifies `X-SEO-Autopilot-Signature = hmac(secret, "<ts>.<payload>")` and timestamp freshness. */
export function verifySignature(ts: string | null, sig: string | null, payload: string, nowS = Math.floor(Date.now() / 1000)): boolean {
  if (!ts || !sig || !/^\d+$/.test(ts)) return false;
  if (Math.abs(nowS - Number(ts)) > MAX_CLOCK_SKEW_S) return false;
  return safeEqual(sig, hmacSha256(callbackSecret(), `${ts}.${payload}`));
}

function acceptanceCriteria(o: typeof opportunities.$inferSelect): string[] {
  const common = ["Implements the proposed action and nothing else.", "next build passes; no routes removed; no noindex added."];
  switch (o.type) {
    case "metadata":
    case "ctr_improvement":
    case "ranking_opportunity":
      return [...common, "Title under 60 characters and meta description under 160, unique across the site, set via the Metadata API.", o.targetQuery ? `Title, H1 and opening copy clearly address “${o.targetQuery}” without stuffing.` : ""].filter(Boolean);
    case "new_service_page":
    case "new_location_page":
      return [...common, "New page has a unique title, meta description, H1 and self-referencing canonical.", "New page is linked from at least one existing page and appears in the sitemap.", "Uses only the services and locations in the spec."];
    case "internal_linking":
      return [...common, "Links use descriptive anchor text and point at existing routes."];
    case "blog_content":
      return [
        ...common,
        `Adds a new blog post at ${o.targetUrl ?? "the blog"} using the site’s existing blog structure and layout (no new design or dependencies).`,
        "Uses content.body_markdown as provided (formatting only), with content.title as the H1 and title, and content.meta_description as the meta description.",
        "Post has a self-referencing canonical, is listed on the blog index and appears in the sitemap.",
      ];
    case "schema":
      return [...common, "JSON-LD parses and has the correct @type."];
    default:
      return common;
  }
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/** True while another GitHub job for this client is still in flight (one at a time, §11.1). */
export async function clientHasActiveJob(clientId: string, exceptBatchId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: githubJobs.id })
    .from(githubJobs)
    .where(
      and(
        eq(githubJobs.clientId, clientId),
        eq(githubJobs.kind, "batch"),
        inArray(githubJobs.status, ["dispatched", "running"]),
        gte(githubJobs.createdAt, new Date(Date.now() - 75 * 60_000)),
        sql`${githubJobs.batchId} <> ${exceptBatchId}`,
      ),
    )
    .limit(1);
  return !!row;
}

export async function dispatchGithubBatch(batchId: string, executionIds: string[]): Promise<{ status: "dispatched" | "action_needed" | "already"; message: string }> {
  const [row] = await db
    .select({ batch: batches, client: clients })
    .from(batches)
    .innerJoin(clients, eq(clients.id, batches.clientId))
    .where(eq(batches.id, batchId));
  if (!row) throw new Error(`Batch ${batchId} not found`);
  const { client } = row;

  const [existing] = await db.select().from(githubJobs).where(and(eq(githubJobs.batchId, batchId), eq(githubJobs.kind, "batch")));
  if (existing) return { status: "already", message: "Already dispatched" };

  const needAction = async (title: string, detail: string, dedupeKey: string) => {
    // "failed" (not "action needed") so the Actioned tab offers Retry once the blocker is fixed.
    await setExecutionStatus(executionIds, "failed", { actor: "system", error: title });
    await raiseAttention({ dedupeKey, kind: "integration", clientId: client.id, title, detail, link: `/clients/${client.id}/settings` });
    return { status: "action_needed" as const, message: title };
  };
  if (!githubConfigured()) return needAction("Set up the GitHub App", "Website changes need the GitHub App. See the README.", "github_app_missing");
  if (!client.githubRepo) return needAction(`Add a GitHub repository for ${client.name}`, "Website changes are made in the client’s repo.", `github_repo:${client.id}`);
  const base = client.githubDefaultBranch ?? (await github.getRepo(client.githubRepo))?.defaultBranch;
  if (!base) return needAction(`GitHub App can’t access ${client.githubRepo}`, "Add the repository to the App installation.", `github_repo:${client.id}`);
  const workflow = await github.readFile(client.githubRepo, ".github/workflows/seo-autopilot.yml", base);
  if (workflow === null) {
    return needAction(
      `Merge the SEO Autopilot setup PR for ${client.name}`,
      "The workflow isn’t on the default branch yet, so Claude Code can’t run. Merge the setup PR, then tap Retry.",
      `setup_missing:${client.id}`,
    );
  }

  const shortId = batchId.slice(0, 8);
  const [job] = await db
    .insert(githubJobs)
    .values({ batchId, clientId: client.id, kind: "batch", repo: client.githubRepo, branch: `seo-autopilot/batch-${shortId}`, status: "dispatched" })
    .returning();
  try {
    await github.dispatchWorkflow(client.githubRepo, base, { batch_id: batchId, spec_url: `${appUrl()}/api/github-callback/spec/${batchId}` });
  } catch (e) {
    await db.update(githubJobs).set({ status: "failed" }).where(eq(githubJobs.id, job!.id));
    throw e; // the Inngest step retries; a fresh job row is created next time
  }
  await setExecutionStatus(executionIds, "running", { actor: "system" });
  await resolveAttention(`setup_missing:${client.id}`);
  await audit({ actor: "system", clientId: client.id, entityType: "github_job", entityId: job!.id, event: "github.dispatched", after: { repo: client.githubRepo, branch: job!.branch } });
  return { status: "dispatched", message: `Dispatched to ${client.githubRepo}` };
}

// ── Spec (GET /api/github-callback/spec/[batchId]) ─────────────────────────────

export async function buildSpec(batchId: string): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ batch: batches, client: clients })
    .from(batches)
    .innerJoin(clients, eq(clients.id, batches.clientId))
    .where(eq(batches.id, batchId));
  const [job] = await db
    .select()
    .from(githubJobs)
    .where(and(eq(githubJobs.batchId, batchId), eq(githubJobs.kind, "batch")))
    .orderBy(desc(githubJobs.createdAt))
    .limit(1);
  if (!row || !job || !["dispatched", "running"].includes(job.status)) return null;

  const items = await db
    .select({ exec: executions, opp: opportunities })
    .from(executions)
    .innerJoin(opportunities, eq(opportunities.id, executions.opportunityId))
    .where(and(eq(executions.batchId, batchId), inArray(executions.status, ["queued", "running"]), inArray(executions.executionType, ["github_pr", "content_generation"])));

  // A fresh one-time token per spec fetch; only its hash is stored (§11.2).
  const token = randomToken();
  await db
    .update(githubJobs)
    .set({ callbackTokenHash: sha256(token), callbackTokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS) })
    .where(eq(githubJobs.id, job.id));

  const c = row.client;
  return {
    batch_id: batchId,
    short_id: batchId.slice(0, 8),
    branch: job.branch,
    base_branch: c.githubDefaultBranch ?? "main",
    callback_url: `${appUrl()}/api/github-callback/${batchId}`,
    callback_token: token,
    app_batch_url: `${appUrl()}/clients/${c.id}/actioned`,
    client: {
      name: c.name,
      domain: c.domain,
      services: c.services,
      priority_services: c.priorityServices,
      locations: c.locations,
      excluded_services: c.excludedServices,
      excluded_locations: c.excludedLocations,
      brand_tone: c.brandTone,
    },
    guardrails: GUARDRAILS,
    qa: { max_changed_lines: 1500, similarity_threshold: 0.8 },
    items: items.map(({ opp }) => {
      const draft = (opp.payload?.draft ?? null) as { title?: string; body?: string; slug?: string; meta_description?: string } | null;
      return {
        opportunity_id: opp.id,
        ref: oppRef(opp.id),
        title: opp.title,
        proposed_action: opp.proposedAction,
        target_url: opp.targetUrl,
        evidence: opp.evidence as EvidenceItem[],
        acceptance_criteria: acceptanceCriteria(opp),
        ...(draft?.body ? { content: { title: draft.title ?? opp.title, slug: draft.slug ?? null, body_markdown: draft.body, meta_description: draft.meta_description ?? null } } : {}),
      };
    }),
  };
}

// ── Callbacks (POST /api/github-callback/[batchId]) ────────────────────────────

const callbackSchema = z.object({
  event: z.enum(["started", "item_done", "qa_result", "pr_opened", "failed"]),
  idempotency_key: z.string().min(1).max(300),
  run_id: z.union([z.string(), z.number()]).transform(String),
  run_url: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});

export type CallbackResult = { status: number; body: Record<string, unknown> };

export async function handleCallback(batchId: string, raw: string, h: { ts: string | null; sig: string | null; token: string | null }): Promise<CallbackResult> {
  if (!verifySignature(h.ts, h.sig, raw)) return { status: 401, body: { error: "Bad signature" } };
  let parsed: z.infer<typeof callbackSchema>;
  try {
    parsed = callbackSchema.parse(JSON.parse(raw));
  } catch {
    return { status: 400, body: { error: "Bad payload" } };
  }
  const [job] = await db
    .select()
    .from(githubJobs)
    .where(and(eq(githubJobs.batchId, batchId), eq(githubJobs.kind, "batch")))
    .orderBy(desc(githubJobs.createdAt))
    .limit(1);
  if (!job) return { status: 404, body: { error: "Unknown batch" } };

  // The one-time token is required, except for a "failed" sent before the spec could be fetched.
  if (h.token) {
    const valid = job.callbackTokenHash && job.callbackTokenExpiresAt && job.callbackTokenExpiresAt > new Date() && safeEqual(sha256(h.token), job.callbackTokenHash);
    if (!valid) return { status: 401, body: { error: "Bad token" } };
  } else if (parsed.event !== "failed") {
    return { status: 401, body: { error: "Missing token" } };
  }

  // Idempotency: each event key is processed once. 409 tells the workflow it was already delivered.
  const [fresh] = await db
    .insert(webhookEvents)
    .values({ provider: "github_callback", deliveryId: `${batchId}:${parsed.idempotency_key}` })
    .onConflictDoNothing()
    .returning();
  if (!fresh) return { status: 409, body: { ok: true, duplicate: true } };

  await applyCallback(job, parsed);
  await db.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.id, fresh.id));
  return { status: 200, body: { ok: true } };
}

async function batchExecutions(batchId: string, statuses: (typeof executions.$inferSelect)["status"][]) {
  return db
    .select()
    .from(executions)
    .where(and(eq(executions.batchId, batchId), inArray(executions.status, statuses), inArray(executions.executionType, ["github_pr", "content_generation"])));
}

async function applyCallback(job: typeof githubJobs.$inferSelect, cb: z.infer<typeof callbackSchema>) {
  const batchId = job.batchId!;
  const now = new Date();
  const d = cb.data;
  await db.update(githubJobs).set({ lastCallbackAt: now, workflowRunId: cb.run_id }).where(eq(githubJobs.id, job.id));
  await audit({ actor: "claude_code", clientId: job.clientId, entityType: "github_job", entityId: job.id, event: `github.callback.${cb.event}`, after: { runUrl: cb.run_url, data: d } });

  switch (cb.event) {
    case "started": {
      await db.update(githubJobs).set({ status: "running" }).where(eq(githubJobs.id, job.id));
      const queued = await batchExecutions(batchId, ["queued"]);
      await setExecutionStatus(queued.map((e) => e.id), "running", { actor: "claude_code" });
      return;
    }
    case "item_done": {
      const oppId = typeof d.opportunity_id === "string" ? d.opportunity_id : null;
      const [exec] = oppId ? await db.select().from(executions).where(and(eq(executions.batchId, batchId), eq(executions.opportunityId, oppId))) : [];
      if (!exec || !["queued", "running"].includes(exec.status)) return;
      if (d.status === "skipped") {
        await setExecutionStatus([exec.id], "failed", { actor: "claude_code", error: `Skipped by Claude Code: ${String(d.reason ?? "no reason given").slice(0, 300)}` });
      } else {
        await db.update(executions).set({ result: { ...(exec.result ?? {}), commitSha: d.commit_sha ?? null } }).where(eq(executions.id, exec.id));
      }
      return;
    }
    case "qa_result":
      await db.update(githubJobs).set({ qaResults: d }).where(eq(githubJobs.id, job.id));
      return;
    case "pr_opened": {
      const prNumber = Number(d.pr_number);
      const prUrl = String(d.pr_url ?? "");
      await db.update(githubJobs).set({ status: "pr_opened", prNumber, prUrl }).where(eq(githubJobs.id, job.id));
      const done = await batchExecutions(batchId, ["queued", "running"]);
      for (const e of done) {
        await setExecutionStatus([e.id], "pr_ready", { actor: "claude_code", result: { ...(e.result ?? {}), prNumber, prUrl } });
      }
      const [c] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, job.clientId));
      await raiseAttention({
        dedupeKey: `pr_review:${batchId}`,
        kind: "pr_review",
        clientId: job.clientId,
        title: `PR #${prNumber} ready — ${done.length} change${done.length === 1 ? "" : "s"} for ${c?.name ?? "client"}`,
        detail: "SEO QA passed. Review and merge on GitHub; nothing is merged automatically.",
        link: prUrl,
        meta: { batchId },
      });
      await notify("failures", `PR #${prNumber} ready for ${c?.name ?? "a client"}: ${prUrl}`);
      return;
    }
    case "failed": {
      await failJob(job, `Failed at ${String(d.step ?? "unknown step")}: ${String(d.message ?? "no message")}`.slice(0, 500), String(d.log_excerpt ?? "").slice(0, 4000));
      return;
    }
  }
}

export async function failJob(job: typeof githubJobs.$inferSelect, message: string, logExcerpt = "") {
  await db.update(githubJobs).set({ status: "failed", qaResults: { ...(job.qaResults ?? {}), failure: { message, logExcerpt } } }).where(eq(githubJobs.id, job.id));
  const open = await batchExecutions(job.batchId!, ["queued", "running"]);
  await setExecutionStatus(open.map((e) => e.id), "failed", { actor: "claude_code", error: message });
  const [c] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, job.clientId));
  await notify("failures", `:x: Batch failed for ${c?.name ?? "a client"}: ${message.slice(0, 160)} ${appLink(`/clients/${job.clientId}/actioned`, "Open")}`);
}

// ── PR merged / closed (GitHub webhook) ────────────────────────────────────────

export async function onBatchPrClosed(repo: string, prNumber: number, merged: boolean): Promise<{ batchId: string } | null> {
  const [job] = await db
    .select()
    .from(githubJobs)
    .where(and(eq(githubJobs.repo, repo), eq(githubJobs.prNumber, prNumber), eq(githubJobs.kind, "batch"), isNull(githubJobs.mergedAt)));
  if (!job?.batchId) return null;
  const ready = await batchExecutions(job.batchId, ["pr_ready"]);
  if (merged) {
    await db.update(githubJobs).set({ status: "merged", mergedAt: new Date() }).where(eq(githubJobs.id, job.id));
    await setExecutionStatus(ready.map((e) => e.id), "merged", { actor: "webhook" });
  } else {
    await db.update(githubJobs).set({ status: "closed" }).where(eq(githubJobs.id, job.id));
    await setExecutionStatus(ready.map((e) => e.id), "cancelled", { actor: "webhook" });
    if (ready.length) {
      await db
        .update(opportunities)
        .set({ status: "recommended", batchId: null, decidedAt: null, decidedBy: null, statusNote: "PR closed without merging" })
        .where(inArray(opportunities.id, ready.map((e) => e.opportunityId)));
    }
  }
  await resolveAttention(`pr_review:${job.batchId}`);
  return merged ? { batchId: job.batchId } : null;
}

/** Backup for lost callbacks: a workflow run that ends badly fails its job. */
export async function onWorkflowRunCompleted(repo: string, displayTitle: string, conclusion: string | null, runUrl: string) {
  const m = displayTitle.match(/batch ([0-9a-f-]{36})/i);
  if (!m || conclusion === "success") return;
  const [job] = await db
    .select()
    .from(githubJobs)
    .where(and(eq(githubJobs.repo, repo), eq(githubJobs.batchId, m[1]!), eq(githubJobs.kind, "batch"), inArray(githubJobs.status, ["dispatched", "running"])));
  if (job) await failJob(job, `Workflow run ${conclusion ?? "ended"} without reporting back (${runUrl})`);
}

// ── Reconciliation (github.reconcile, every 10 min) ────────────────────────────

export async function reconcileJobs(now = new Date()): Promise<{ checked: number; failed: number }> {
  const quietSince = new Date(now.getTime() - 15 * 60_000);
  const stuck = await db
    .select()
    .from(githubJobs)
    .where(
      and(
        eq(githubJobs.kind, "batch"),
        inArray(githubJobs.status, ["dispatched", "running"]),
        or(lt(githubJobs.lastCallbackAt, quietSince), and(isNull(githubJobs.lastCallbackAt), lt(githubJobs.createdAt, quietSince))),
      ),
    );
  let failed = 0;
  for (const job of stuck) {
    const ageMin = (now.getTime() - job.createdAt.getTime()) / 60_000;
    let run: Awaited<ReturnType<typeof github.listWorkflowRuns>>[number] | undefined;
    try {
      const runs = await github.listWorkflowRuns(job.repo, new Date(job.createdAt.getTime() - 60_000));
      run = runs.find((r) => (r.display_title ?? r.name ?? "").includes(job.batchId!)) ?? runs.find((r) => String(r.id) === job.workflowRunId);
    } catch {
      // GitHub unavailable: only the 60-minute timeout applies this round.
    }
    if (run?.status === "completed" && run.conclusion !== "success") {
      await failJob(job, `Workflow run ${run.conclusion} (${run.html_url})`);
      failed++;
    } else if (run?.status === "completed" && run.conclusion === "success" && job.status !== "pr_opened") {
      await failJob(job, `Workflow finished without opening a PR (${run.html_url})`);
      failed++;
    } else if (ageMin > 60) {
      await failJob(job, "Timed out after 60 minutes");
      failed++;
    } else if (!run && ageMin > 15) {
      await failJob(job, "The workflow never started. Check the repo’s Actions settings and secrets.");
      failed++;
    }
  }
  return { checked: stuck.length, failed };
}

// ── Deployment verification (deployment.verify) ───────────────────────────────

export type VerifyTarget = { executionId: string; url: string; newPage: boolean };

export async function verifyTargets(batchId: string): Promise<VerifyTarget[]> {
  const rows = await db
    .select({ exec: executions, opp: opportunities, client: clients })
    .from(executions)
    .innerJoin(opportunities, eq(opportunities.id, executions.opportunityId))
    .innerJoin(clients, eq(clients.id, opportunities.clientId))
    .where(and(eq(executions.batchId, batchId), eq(executions.status, "merged")));
  return rows.map(({ exec, opp, client }) => {
    const t = opp.targetUrl ?? "/";
    const path = t.startsWith("/") && !t.includes("*") ? t : "/";
    return { executionId: exec.id, url: new URL(path, client.websiteUrl).toString(), newPage: !!(opp.payload as { newPage?: boolean } | null)?.newPage };
  });
}

/** Pass = HTTP 200, indexable, and has a title and meta description. */
export async function checkLive(url: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "SEO-Autopilot-Verify/1.0" }, signal: AbortSignal.timeout(15_000) });
    if (res.status !== 200) return { ok: false, reason: `HTTP ${res.status}` };
    if (/noindex/i.test(res.headers.get("x-robots-tag") ?? "")) return { ok: false, reason: "X-Robots-Tag noindex" };
    const html = (await res.text()).slice(0, 300_000);
    if (/<meta[^>]+name=["']robots["'][^>]+noindex/i.test(html)) return { ok: false, reason: "meta robots noindex" };
    if (!/<title[^>]*>\s*[^<\s][^<]*<\/title>/i.test(html)) return { ok: false, reason: "No title" };
    if (!/<meta[^>]+name=["']description["'][^>]+content=["'][^"']+["']/i.test(html) && !/<meta[^>]+content=["'][^"']+["'][^>]+name=["']description["']/i.test(html)) {
      return { ok: false, reason: "No meta description" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "Request failed" };
  }
}

export async function finishVerification(batchId: string, results: { executionId: string; ok: boolean; reason?: string; url: string }[], final: boolean) {
  const passed = results.filter((r) => r.ok).map((r) => r.executionId);
  await setExecutionStatus(passed, "live", { actor: "system" });
  if (!final) return;
  const failedRows = results.filter((r) => !r.ok);
  for (const f of failedRows) {
    await setExecutionStatus([f.executionId], "action_needed", { actor: "system", error: `Not verified live: ${f.url} — ${f.reason}` });
  }
  if (failedRows.length) {
    const [b] = await db.select({ clientId: batches.clientId }).from(batches).where(eq(batches.id, batchId));
    await raiseAttention({
      dedupeKey: `verify:${batchId}`,
      kind: "manual_action",
      clientId: b?.clientId,
      title: `Check ${failedRows.length} change${failedRows.length === 1 ? "" : "s"} after deploy`,
      detail: failedRows.map((f) => `${f.url}: ${f.reason}`).join("; ").slice(0, 300),
      link: b ? `/clients/${b.clientId}/actioned` : null,
      meta: { batchId, checklist: ["Open each URL and check it loads", "Check the deploy finished on Vercel", "Tap Mark done once it’s live"] },
    });
  }
  await db.update(githubJobs).set({ verifiedAt: new Date() }).where(and(eq(githubJobs.batchId, batchId), eq(githubJobs.kind, "batch")));
}
