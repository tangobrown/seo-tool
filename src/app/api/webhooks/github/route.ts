import { and, eq, isNull } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { githubJobs, webhookEvents } from "@/db/schema";
import { audit } from "@/lib/audit";
import { resolveAttention } from "@/lib/attention";
import { hmacSha256, safeEqual } from "@/lib/crypto";
import { EVENTS, inngest } from "@/jobs/client";
import { onBatchPrClosed, onWorkflowRunCompleted } from "@/server/github-exec";

const prEvent = z.object({
  action: z.string(),
  pull_request: z.object({ number: z.number(), merged: z.boolean().nullable().optional(), head: z.object({ ref: z.string() }) }),
  repository: z.object({ full_name: z.string() }),
});

const runEvent = z.object({
  action: z.string(),
  workflow_run: z.object({ name: z.string().nullable().optional(), display_title: z.string().nullable().optional(), conclusion: z.string().nullable(), html_url: z.string() }),
  repository: z.object({ full_name: z.string() }),
});

/**
 * GitHub App webhooks. Signature verified; deduped by delivery ID.
 * Handles setup and batch PRs closing (merge → production verification) and workflow runs finishing.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.GITHUB_APP_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
  const raw = await req.text();
  const sig = req.headers.get("x-hub-signature-256") ?? "";
  if (!safeEqual(sig, `sha256=${hmacSha256(secret, raw)}`)) return NextResponse.json({ error: "Bad signature" }, { status: 401 });

  const deliveryId = req.headers.get("x-github-delivery");
  const event = req.headers.get("x-github-event");
  if (!deliveryId || !event) return NextResponse.json({ error: "Missing headers" }, { status: 400 });

  const [fresh] = await db.insert(webhookEvents).values({ provider: "github", deliveryId }).onConflictDoNothing().returning();
  if (!fresh) return NextResponse.json({ ok: true, duplicate: true });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  if (event === "pull_request") {
    const p = prEvent.safeParse(body);
    if (p.success && p.data.action === "closed") {
      const { pull_request: pr, repository } = p.data;
      // Batch PRs: merged → verify on production; closed → back to Recommendations.
      const merged = await onBatchPrClosed(repository.full_name, pr.number, !!pr.merged);
      if (merged) {
        await inngest.send({ name: EVENTS.deploymentVerify, data: { batchId: merged.batchId }, id: `verify-${merged.batchId}` });
      }
      const [job] = await db
        .update(githubJobs)
        .set({ status: pr.merged ? "merged" : "closed", mergedAt: pr.merged ? new Date() : null })
        .where(and(eq(githubJobs.repo, repository.full_name), eq(githubJobs.prNumber, pr.number), eq(githubJobs.kind, "setup"), isNull(githubJobs.mergedAt)))
        .returning();
      if (job) {
        await resolveAttention(`setup_pr:${job.clientId}`);
        await audit({
          actor: "webhook",
          clientId: job.clientId,
          entityType: "github_job",
          entityId: job.id,
          event: pr.merged ? "setup_pr.merged" : "setup_pr.closed",
          after: { pr: pr.number },
        });
      }
    }
  }

  if (event === "workflow_run") {
    const w = runEvent.safeParse(body);
    if (w.success && w.data.action === "completed") {
      const run = w.data.workflow_run;
      await onWorkflowRunCompleted(w.data.repository.full_name, run.display_title ?? run.name ?? "", run.conclusion, run.html_url);
    }
  }

  await db.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.deliveryId, deliveryId));
  return NextResponse.json({ ok: true });
}
