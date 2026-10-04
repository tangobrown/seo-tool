"use server";

import { and, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { batches, executions, opportunities, workspace } from "@/db/schema";
import { EVENTS, inngest } from "@/jobs/client";
import { audit } from "@/lib/audit";
import { requireSession } from "@/lib/auth";
import { raiseAttention } from "@/lib/attention";
import { createApprovalBatch } from "@/server/batches";
import { recomputeBatchStatus } from "@/server/execution";

const ids = z.array(z.string().uuid()).min(1).max(200);
const uuid = z.string().uuid();

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function revalidateClient(clientId: string) {
  revalidatePath(`/clients/${clientId}`, "layout");
  revalidatePath("/", "layout");
}

async function workspaceSettings() {
  const [w] = await db.select().from(workspace).where(eq(workspace.id, 1));
  return { undoWindowSeconds: w?.undoWindowSeconds ?? 120, deferDays: w?.deferDays ?? 28 };
}

/**
 * Approve creates a batch that starts after the undo window. The client sends an idempotency key,
 * so a double tap or retry creates exactly one batch.
 */
export async function approveRecommendations(input: {
  clientId: string;
  opportunityIds: string[];
  idempotencyKey: string;
}): Promise<ActionResult<{ batchId: string; count: number; startsAt: string }>> {
  await requireSession();
  const parsed = z.object({ clientId: uuid, opportunityIds: ids, idempotencyKey: uuid }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request" };
  const { clientId, opportunityIds, idempotencyKey } = parsed.data;
  const { undoWindowSeconds } = await workspaceSettings();

  const result = await createApprovalBatch({ clientId, opportunityIds, idempotencyKey, undoWindowSeconds });

  if (!result.count) return { ok: false, error: "Those recommendations were already actioned." };
  if (!result.duplicate) {
    try {
      await inngest.send({ name: EVENTS.batchApproved, data: { batchId: result.batch.id, clientId }, id: `batch-${result.batch.id}` });
    } catch (e) {
      // The batch-sweep job re-sends lost events, so the batch still starts. Surface it anyway.
      console.error("Failed to send batch.approved", e);
      await raiseAttention({
        dedupeKey: `inngest_send:${result.batch.id}`,
        kind: "integration",
        clientId,
        title: "Couldn’t reach the job queue",
        detail: "The batch was saved and will start when the queue is reachable.",
        link: "/settings/integrations",
      });
    }
  }
  revalidateClient(clientId);
  return { ok: true, batchId: result.batch.id, count: result.count, startsAt: result.batch.startsAt.toISOString() };
}

/** Undo / Cancel batch. Only while the batch hasn't started. */
export async function cancelBatch(batchId: string): Promise<ActionResult> {
  await requireSession();
  if (!uuid.safeParse(batchId).success) return { ok: false, error: "Invalid request" };
  const out = await db.transaction(async (tx) => {
    const [batch] = await tx
      .update(batches)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(and(eq(batches.id, batchId), eq(batches.status, "pending_start")))
      .returning();
    if (!batch) return null;
    await tx.update(executions).set({ status: "cancelled" }).where(eq(executions.batchId, batchId));
    const restored = await tx
      .update(opportunities)
      .set({ status: "recommended", decidedAt: null, decidedBy: null, batchId: null })
      .where(and(eq(opportunities.batchId, batchId), eq(opportunities.status, "approved")))
      .returning({ title: opportunities.title });
    await audit(
      {
        actor: "operator",
        clientId: batch.clientId,
        entityType: "batch",
        entityId: batchId,
        event: "batch.cancelled",
        before: { status: "pending_start" },
        after: { status: "cancelled", restored: restored.map((r) => r.title) },
      },
      tx,
    );
    return batch;
  });
  if (!out) return { ok: false, error: "This batch has already started." };
  revalidateClient(out.clientId);
  return { ok: true };
}

export async function deferRecommendations(input: { clientId: string; opportunityIds: string[] }): Promise<ActionResult<{ count: number }>> {
  await requireSession();
  const parsed = z.object({ clientId: uuid, opportunityIds: ids }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request" };
  const { deferDays } = await workspaceSettings();
  const until = new Date(Date.now() + deferDays * 86400_000);
  const rows = await db
    .update(opportunities)
    .set({ status: "deferred", deferredUntil: until, decidedAt: new Date(), decidedBy: "operator" })
    .where(
      and(
        eq(opportunities.clientId, parsed.data.clientId),
        inArray(opportunities.id, parsed.data.opportunityIds),
        eq(opportunities.status, "recommended"),
      ),
    )
    .returning({ id: opportunities.id, title: opportunities.title });
  await audit({
    actor: "operator",
    clientId: parsed.data.clientId,
    entityType: "opportunity",
    event: "recommendations.deferred",
    after: { until: until.toISOString(), opportunities: rows.map((r) => r.title) },
  });
  revalidateClient(parsed.data.clientId);
  return { ok: true, count: rows.length };
}

export async function declineRecommendations(input: { clientId: string; opportunityIds: string[] }): Promise<ActionResult<{ count: number }>> {
  await requireSession();
  const parsed = z.object({ clientId: uuid, opportunityIds: ids }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request" };
  const rows = await db
    .update(opportunities)
    // Score at decision powers the "reappears only if the score rises by 15" rule (§10.4).
    .set({ status: "declined", decidedAt: new Date(), decidedBy: "operator", scoreAtDecision: sql`${opportunities.priorityScore}` })
    .where(
      and(
        eq(opportunities.clientId, parsed.data.clientId),
        inArray(opportunities.id, parsed.data.opportunityIds),
        eq(opportunities.status, "recommended"),
      ),
    )
    .returning({ id: opportunities.id, title: opportunities.title });
  await audit({
    actor: "operator",
    clientId: parsed.data.clientId,
    entityType: "opportunity",
    event: "recommendations.declined",
    after: { opportunities: rows.map((r) => r.title) },
  });
  revalidateClient(parsed.data.clientId);
  return { ok: true, count: rows.length };
}

/**
 * "Move back" to pending. Allowed for deferred/declined items, and for approved items whose batch
 * hasn't started (which removes them from the batch).
 */
export async function moveBack(input: { clientId: string; opportunityIds: string[] }): Promise<ActionResult<{ count: number }>> {
  await requireSession();
  const parsed = z.object({ clientId: uuid, opportunityIds: ids }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request" };
  const { clientId, opportunityIds } = parsed.data;

  const res = await db.transaction(async (tx) => {
    const opps = await tx
      .select({ opp: opportunities, batchStatus: batches.status })
      .from(opportunities)
      .leftJoin(batches, eq(batches.id, opportunities.batchId))
      .where(and(eq(opportunities.clientId, clientId), inArray(opportunities.id, opportunityIds)));
    const movable = opps.filter(
      (o) =>
        o.opp.status === "deferred" ||
        o.opp.status === "declined" ||
        (o.opp.status === "approved" && o.batchStatus === "pending_start"),
    );
    if (!movable.length) return { count: 0, touchedBatches: [] as string[] };
    const fromBatch = movable.filter((o) => o.opp.status === "approved");
    const touchedBatches = [...new Set(fromBatch.map((o) => o.opp.batchId!))];
    if (fromBatch.length) {
      await tx
        .update(executions)
        .set({ status: "cancelled" })
        .where(and(inArray(executions.opportunityId, fromBatch.map((o) => o.opp.id)), eq(executions.status, "queued")));
    }
    await tx
      .update(opportunities)
      .set({ status: "recommended", decidedAt: null, decidedBy: null, batchId: null, deferredUntil: null })
      .where(inArray(opportunities.id, movable.map((o) => o.opp.id)));
    // A pending batch with nothing left in it is cancelled.
    for (const b of touchedBatches) {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(executions)
        .where(and(eq(executions.batchId, b), eq(executions.status, "queued")));
      if (n === 0) {
        await tx.update(batches).set({ status: "cancelled", finishedAt: new Date() }).where(and(eq(batches.id, b), eq(batches.status, "pending_start")));
      }
    }
    await audit(
      {
        actor: "operator",
        clientId,
        entityType: "opportunity",
        event: "recommendations.moved_back",
        before: movable.map((o) => ({ title: o.opp.title, status: o.opp.status })),
        after: { status: "recommended" },
      },
      tx,
    );
    return { count: movable.length, touchedBatches };
  });
  revalidateClient(clientId);
  return { ok: true, count: res.count };
}

/** Retry a failed execution: a new attempt with a new idempotency key in a fresh batch. */
export async function retryExecution(executionId: string): Promise<ActionResult> {
  await requireSession();
  if (!uuid.safeParse(executionId).success) return { ok: false, error: "Invalid request" };
  const out = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ exec: executions, batch: batches })
      .from(executions)
      .innerJoin(batches, eq(batches.id, executions.batchId))
      .where(eq(executions.id, executionId));
    if (!row || row.exec.status !== "failed") return null;
    const [batch] = await tx
      .insert(batches)
      .values({ clientId: row.batch.clientId, idempotencyKey: crypto.randomUUID(), startsAt: new Date(), createdBy: "operator" })
      .returning();
    await tx.insert(executions).values({
      batchId: batch!.id,
      opportunityId: row.exec.opportunityId,
      executionType: row.exec.executionType,
      attempt: row.exec.attempt + 1,
      idempotencyKey: `${batch!.id}:${row.exec.opportunityId}:${row.exec.attempt + 1}`,
    });
    // The failed attempt is superseded.
    await tx.update(executions).set({ status: "cancelled" }).where(eq(executions.id, executionId));
    await tx.update(opportunities).set({ batchId: batch!.id, status: "approved" }).where(eq(opportunities.id, row.exec.opportunityId));
    await audit(
      { actor: "operator", clientId: row.batch.clientId, entityType: "execution", entityId: executionId, event: "execution.retried", after: { batchId: batch!.id, attempt: row.exec.attempt + 1 } },
      tx,
    );
    return { batch: batch!, oldBatchId: row.batch.id };
  });
  if (!out) return { ok: false, error: "Only failed changes can be retried." };
  await recomputeBatchStatus(out.oldBatchId);
  await inngest.send({ name: EVENTS.batchApproved, data: { batchId: out.batch.id, clientId: out.batch.clientId }, id: `batch-${out.batch.id}` });
  revalidateClient(out.batch.clientId);
  return { ok: true };
}
