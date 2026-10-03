import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { batches, executions, opportunities } from "@/db/schema";
import { audit } from "@/lib/audit";

/**
 * Creates an approval batch in one transaction: batch (pending_start until the undo window ends),
 * opportunities → approved, one queued execution each, audit entry. The idempotency key makes a
 * duplicate submission return the first batch instead of creating another.
 */
export async function createApprovalBatch(input: {
  clientId: string;
  opportunityIds: string[];
  idempotencyKey: string;
  undoWindowSeconds: number;
}) {
  const { clientId, opportunityIds, idempotencyKey, undoWindowSeconds } = input;
  return db.transaction(async (tx) => {
    const startsAt = new Date(Date.now() + undoWindowSeconds * 1000);
    const [batch] = await tx
      .insert(batches)
      .values({ clientId, idempotencyKey, startsAt, createdBy: "operator" })
      .onConflictDoNothing({ target: batches.idempotencyKey })
      .returning();
    if (!batch) {
      // Duplicate submission: return the batch created by the first one.
      const [existing] = await tx.select().from(batches).where(eq(batches.idempotencyKey, idempotencyKey));
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(executions)
        .where(eq(executions.batchId, existing!.id));
      return { batch: existing!, count: n, duplicate: true };
    }
    const now = new Date();
    const approved = await tx
      .update(opportunities)
      .set({ status: "approved", decidedAt: now, decidedBy: "operator", batchId: batch.id, statusNote: null })
      .where(
        and(
          eq(opportunities.clientId, clientId),
          inArray(opportunities.id, opportunityIds),
          eq(opportunities.status, "recommended"),
        ),
      )
      .returning({ id: opportunities.id, executionType: opportunities.executionType, title: opportunities.title });
    if (!approved.length) {
      await tx.update(batches).set({ status: "cancelled" }).where(eq(batches.id, batch.id));
      return { batch, count: 0, duplicate: false };
    }
    await tx.insert(executions).values(
      approved.map((o) => ({
        batchId: batch.id,
        opportunityId: o.id,
        executionType: o.executionType,
        idempotencyKey: `${batch.id}:${o.id}:1`,
      })),
    );
    await audit(
      {
        actor: "operator",
        clientId,
        entityType: "batch",
        entityId: batch.id,
        event: "recommendations.approved",
        after: { batchId: batch.id, startsAt: startsAt.toISOString(), opportunities: approved.map((o) => o.title) },
      },
      tx,
    );
    return { batch, count: approved.length, duplicate: false };
  });
}
