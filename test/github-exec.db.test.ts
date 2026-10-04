// Phase 5 contract test: the REAL client-repo helper (templates/client-repo/.seo-autopilot/callback.mjs)
// talks to the app's spec and callback handlers over HTTP, exactly as GitHub Actions will.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const hasDb = !!process.env.DATABASE_URL;
const SECRET = "test-callback-secret";
const HELPER = join(process.cwd(), "templates/client-repo/.seo-autopilot/callback.mjs");

describe.skipIf(!hasDb)("Claude Code execution contract", () => {
  let server: Server;
  let base = "";
  let clientId = "";
  let page = `<html><head><title>Acai puree</title><meta name="description" content="Frozen acai puree for cafes"></head><body>ok</body></html>`;
  const tmp = mkdtempSync(join(tmpdir(), "seo-exec-"));

  beforeAll(async () => {
    process.env.GITHUB_CALLBACK_SECRET = SECRET;
    const { buildSpec, handleCallback, verifySignature } = await import("@/server/github-exec");
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      let body = "";
      for await (const chunk of req) body += chunk;
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      };
      const spec = url.pathname.match(/^\/api\/github-callback\/spec\/([0-9a-f-]{36})$/);
      const cb = url.pathname.match(/^\/api\/github-callback\/([0-9a-f-]{36})$/);
      if (spec && req.method === "GET") {
        if (!verifySignature(req.headers["x-seo-autopilot-timestamp"] as string, req.headers["x-seo-autopilot-signature"] as string, spec[1]!)) return send(401, { error: "Bad signature" });
        const s = await buildSpec(spec[1]!);
        return s ? send(200, s) : send(404, {});
      }
      if (cb && req.method === "POST") {
        const out = await handleCallback(cb[1]!, body, {
          ts: (req.headers["x-seo-autopilot-timestamp"] as string) ?? null,
          sig: (req.headers["x-seo-autopilot-signature"] as string) ?? null,
          token: (req.headers["x-seo-autopilot-token"] as string) ?? null,
        });
        return send(out.status, out.body);
      }
      if (req.method === "GET") {
        // Everything else is the client's "live site".
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end(page);
      }
      send(404, {});
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    process.env.APP_URL = base;

    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const [tier] = await db.select().from(s.tiers).limit(1);
    const [c] = await db
      .insert(s.clients)
      .values({ name: "Exec Test", domain: "exec.test", websiteUrl: base, tierId: tier!.id, status: "active", githubRepo: "agency/exec-test", githubDefaultBranch: "main", services: ["Frozen fruit"], locations: ["Exeter"] })
      .returning();
    clientId = c!.id;
  });

  afterAll(async () => {
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const b = await db.select({ id: s.batches.id }).from(s.batches).where(eq(s.batches.clientId, clientId));
    if (b.length) {
      await db.delete(s.executions).where(inArray(s.executions.batchId, b.map((x) => x.id)));
      await db.delete(s.githubJobs).where(inArray(s.githubJobs.batchId, b.map((x) => x.id)));
    }
    await db.update(s.opportunities).set({ batchId: null }).where(eq(s.opportunities.clientId, clientId));
    for (const t of [s.batches, s.opportunities, s.auditLog, s.attentionItems] as const) await db.delete(t).where(eq(t.clientId, clientId));
    await db.delete(s.clients).where(eq(s.clients.id, clientId));
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** An approved, running batch with a dispatched GitHub job (as dispatchGithubBatch leaves it). */
  async function runningBatch(titles: string[]) {
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const opps = await db
      .insert(s.opportunities)
      .values(titles.map((t, i) => ({ clientId, fingerprint: `${t}-${Date.now()}-${i}`, type: "metadata", category: "on_page" as const, title: t, proposedAction: `Do ${t}`, targetUrl: "/acai", evidence: [{ source: "siteguru" as const, metric: "position", value: 6 }], status: "approved" as const })))
      .returning();
    const [batch] = await db.insert(s.batches).values({ clientId, idempotencyKey: crypto.randomUUID(), status: "running", startsAt: new Date() }).returning();
    const execs = await db
      .insert(s.executions)
      .values(opps.map((o) => ({ batchId: batch!.id, opportunityId: o.id, executionType: "github_pr" as const, status: "running" as const, idempotencyKey: crypto.randomUUID() })))
      .returning();
    await db.update(s.opportunities).set({ batchId: batch!.id }).where(inArray(s.opportunities.id, opps.map((o) => o.id)));
    await db.insert(s.githubJobs).values({ batchId: batch!.id, clientId, kind: "batch", repo: "agency/exec-test", branch: `seo-autopilot/batch-${batch!.id.slice(0, 8)}`, status: "dispatched" });
    return { batchId: batch!.id, opps, execs };
  }

  function helper(args: string[], batchId: string, runIdOverride = "4242") {
    return run("node", [HELPER, ...args], {
      env: {
        ...process.env,
        SEO_AUTOPILOT_CALLBACK_SECRET: SECRET,
        SEO_SPEC_PATH: join(tmp, `${batchId}-private.json`),
        SEO_BATCH_ID: batchId,
        SEO_SPEC_URL: `${base}/api/github-callback/spec/${batchId}`,
        GITHUB_RUN_ID: runIdOverride,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_REPOSITORY: "agency/exec-test",
        GITHUB_OUTPUT: join(tmp, "out.txt"),
      },
    });
  }

  async function statuses(batchId: string) {
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    return (await db.select().from(s.executions).where(eq(s.executions.batchId, batchId))).map((e) => e.status).sort();
  }

  it("serves a signed spec and processes callbacks from the real helper, through to Live", async () => {
    const { batchId, opps } = await runningBatch(["Fix the title", "Add FAQ schema"]);
    await helper(["fetch-spec", "--url", `${base}/api/github-callback/spec/${batchId}`, "--batch-id", batchId, "--private-out", join(tmp, `${batchId}-private.json`), "--public-out", join(tmp, `${batchId}-public.json`)], batchId);
    const pub = JSON.parse(readFileSync(join(tmp, `${batchId}-public.json`), "utf8"));
    expect(pub.items).toHaveLength(2);
    expect(pub.items[0].ref).toMatch(/^OPP-/);
    expect(pub.guardrails.length).toBeGreaterThan(3);
    expect(pub.callback_token).toBeUndefined(); // Claude Code never sees the token

    await helper(["send", "started"], batchId);
    await helper(["send", "item_done", "--data", JSON.stringify({ opportunity_id: opps[0]!.id, status: "done", commit_sha: "abc123" })], batchId);
    await helper(["send", "item_done", "--data", JSON.stringify({ opportunity_id: opps[1]!.id, status: "skipped", reason: "No FAQ content on the page" })], batchId);
    // Duplicate delivery (same run, same event, same item): harmless.
    await helper(["send", "item_done", "--data", JSON.stringify({ opportunity_id: opps[1]!.id, status: "skipped", reason: "dup" })], batchId);
    await helper(["send", "qa_result", "--data", JSON.stringify({ passed: true, checks: [] })], batchId);
    await helper(["pr-opened", "--url", "https://github.com/agency/exec-test/pull/7"], batchId);

    expect(await statuses(batchId)).toEqual(["failed", "pr_ready"]);
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const [failed] = await db.select().from(s.executions).where(and(eq(s.executions.batchId, batchId), eq(s.executions.status, "failed")));
    expect(failed!.error).toBe("Skipped by Claude Code: No FAQ content on the page"); // not overwritten by the duplicate
    const [attn] = await db.select().from(s.attentionItems).where(eq(s.attentionItems.dedupeKey, `pr_review:${batchId}`));
    expect(attn!.status).toBe("open");
    expect(attn!.link).toBe("https://github.com/agency/exec-test/pull/7");

    // Merge → verify against the (local) live site → Live.
    const { onBatchPrClosed, verifyTargets, checkLive, finishVerification } = await import("@/server/github-exec");
    expect(await onBatchPrClosed("agency/exec-test", 7, true)).toEqual({ batchId });
    expect(await statuses(batchId)).toEqual(["failed", "merged"]);
    const targets = await verifyTargets(batchId);
    expect(targets.map((t) => t.url)).toEqual([`${base}/acai`]); // client website + target path
    const results = await Promise.all(targets.map(async (t) => ({ ...t, ...(await checkLive(t.url)) })));
    await finishVerification(batchId, results, true);
    expect(await statuses(batchId)).toEqual(["failed", "live"]);
    const [after] = await db.select().from(s.attentionItems).where(eq(s.attentionItems.dedupeKey, `pr_review:${batchId}`));
    expect(after!.status).toBe("resolved");
  });

  it("rejects unsigned or forged requests", async () => {
    const { batchId } = await runningBatch(["Forgery target"]);
    const r1 = await fetch(`${base}/api/github-callback/spec/${batchId}`);
    expect(r1.status).toBe(401);
    const body = JSON.stringify({ event: "pr_opened", idempotency_key: "x", run_id: 1, data: { pr_number: 1, pr_url: "https://evil" } });
    const r2 = await fetch(`${base}/api/github-callback/${batchId}`, { method: "POST", body, headers: { "X-SEO-Autopilot-Timestamp": String(Math.floor(Date.now() / 1000)), "X-SEO-Autopilot-Signature": "0".repeat(64) } });
    expect(r2.status).toBe(401);
    expect(await statuses(batchId)).toEqual(["running"]);
  });

  it("a failed run fails the batch, raises attention, and opens no PR", async () => {
    const { batchId } = await runningBatch(["Will fail QA"]);
    await helper(["fetch-spec", "--url", `${base}/api/github-callback/spec/${batchId}`, "--batch-id", batchId, "--private-out", join(tmp, `${batchId}-private.json`), "--public-out", join(tmp, `${batchId}-public.json`)], batchId, "5151");
    await run("node", [HELPER, "failed"], {
      env: {
        ...process.env,
        SEO_AUTOPILOT_CALLBACK_SECRET: SECRET,
        SEO_SPEC_PATH: join(tmp, `${batchId}-private.json`),
        SEO_BATCH_ID: batchId,
        GITHUB_RUN_ID: "5151",
        SEO_STEP_ORDER: "spec,claude,build,qa",
        OUTCOME_spec: "success",
        OUTCOME_claude: "success",
        OUTCOME_build: "success",
        OUTCOME_qa: "failure",
      },
    });
    expect(await statuses(batchId)).toEqual(["failed"]);
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const [b] = await db.select().from(s.batches).where(eq(s.batches.id, batchId));
    expect(b!.status).toBe("failed");
    const [attn] = await db.select().from(s.attentionItems).where(eq(s.attentionItems.dedupeKey, `failed:${batchId}`));
    expect(attn!.status).toBe("open");
    const [job] = await db.select().from(s.githubJobs).where(eq(s.githubJobs.batchId, batchId));
    expect(job!.prNumber).toBeNull();
  });

  it("a PR closed without merging sends the changes back to Recommendations", async () => {
    const { batchId, opps } = await runningBatch(["Closed PR change"]);
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    await db.update(s.executions).set({ status: "pr_ready" }).where(eq(s.executions.batchId, batchId));
    await db.update(s.githubJobs).set({ prNumber: 99, status: "pr_opened" }).where(eq(s.githubJobs.batchId, batchId));
    const { onBatchPrClosed } = await import("@/server/github-exec");
    expect(await onBatchPrClosed("agency/exec-test", 99, false)).toBeNull();
    const [o] = await db.select().from(s.opportunities).where(eq(s.opportunities.id, opps[0]!.id));
    expect(o!.status).toBe("recommended");
    expect(o!.statusNote).toBe("PR closed without merging");
  });

  it("verification catches a page that went noindex", async () => {
    const { checkLive } = await import("@/server/github-exec");
    page = `<html><head><title>x</title><meta name="robots" content="noindex"><meta name="description" content="d"></head></html>`;
    expect(await checkLive(`${base}/x`)).toEqual({ ok: false, reason: "meta robots noindex" });
  });

  it("reconciliation times out jobs with no callbacks for an hour", async () => {
    const { batchId } = await runningBatch(["Silent job"]);
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    await db.update(s.githubJobs).set({ createdAt: new Date(Date.now() - 61 * 60_000) }).where(eq(s.githubJobs.batchId, batchId));
    const { reconcileJobs } = await import("@/server/github-exec");
    await reconcileJobs();
    expect(await statuses(batchId)).toEqual(["failed"]);
  });
});
