import "server-only";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { batches, clients, executions, opportunities } from "@/db/schema";
import { audit, type AuditActor } from "@/lib/audit";
import { raiseAttention, resolveAttention } from "@/lib/attention";

type ExecStatus = (typeof executions.$inferSelect)["status"];

/** Moves executions to a new status and keeps the opportunity in step. Idempotent. */
export async function setExecutionStatus(
  executionIds: string[],
  status: ExecStatus,
  opts: { actor: AuditActor; error?: string | null; result?: Record<string, unknown> } = { actor: "system" },
) {
  if (!executionIds.length) return;
  const now = new Date();
  const rows = await db
    .update(executions)
    .set({
      status,
      error: opts.error ?? null,
      ...(opts.result ? { result: opts.result } : {}),
      ...(status === "running" ? { startedAt: now } : {}),
      ...(["live", "failed", "cancelled"].includes(status) ? { finishedAt: now } : {}),
    })
    .where(and(inArray(executions.id, executionIds), ne(executions.status, status)))
    .returning();
  if (!rows.length) return;

  const oppIds = rows.map((r) => r.opportunityId);
  const oppStatus =
    status === "live" ? "completed" : status === "failed" ? "approved" : status === "cancelled" ? null : "executing";
  if (oppStatus) await db.update(opportunities).set({ status: oppStatus }).where(inArray(opportunities.id, oppIds));

  const batchId = rows[0]!.batchId;
  const [batch] = await db.select().from(batches).where(eq(batches.id, batchId));
  await audit({
    actor: opts.actor,
    clientId: batch?.clientId,
    entityType: "execution",
    entityId: batchId,
    event: `execution.${status}`,
    after: { executionIds: rows.map((r) => r.id), status, error: opts.error ?? undefined },
  });
  await recomputeBatchStatus(batchId);
}

export async function recomputeBatchStatus(batchId: string) {
  const [batch] = await db.select().from(batches).where(eq(batches.id, batchId));
  if (!batch || batch.status === "cancelled" || batch.status === "pending_start") return;
  const execs = (await db.select().from(executions).where(eq(executions.batchId, batchId))).filter(
    (e) => e.status !== "cancelled",
  );
  if (!execs.length) {
    await resolveAttention(`failed:${batchId}`);
    await resolveAttention(`pr_review:${batchId}`);
    return;
  }
  const st = execs.map((e) => e.status);
  const done = (s: ExecStatus) => s === "live" || s === "failed";
  let next: (typeof batches.$inferSelect)["status"];
  if (st.every((s) => s === "live")) next = "completed";
  else if (st.every((s) => s === "failed")) next = "failed";
  else if (st.every(done)) next = "partially_failed";
  else if (st.some((s) => s === "pr_ready" || s === "merged")) next = "awaiting_merge";
  else next = "running";
  if (next === batch.status) return;
  await db
    .update(batches)
    .set({ status: next, ...(["completed", "failed", "partially_failed"].includes(next) ? { finishedAt: new Date() } : {}) })
    .where(eq(batches.id, batchId));

  if (next === "failed" || next === "partially_failed") {
    const failed = execs.filter((e) => e.status === "failed");
    const [client] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, batch.clientId));
    await raiseAttention({
      dedupeKey: `failed:${batchId}`,
      kind: "failed",
      clientId: batch.clientId,
      title: `Batch failed${failed[0]?.error ? `: ${failed[0].error}` : ""}`,
      detail: `${failed.length} of ${execs.length} changes failed for ${client?.name ?? "client"}.`,
      link: `/clients/${batch.clientId}/actioned`,
      meta: { batchId },
    });
  }
  if (!st.some((s) => s === "failed")) await resolveAttention(`failed:${batchId}`);
  if (!st.some((s) => s === "pr_ready")) await resolveAttention(`pr_review:${batchId}`);
}
