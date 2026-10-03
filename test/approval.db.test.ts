// Integration test against a real Postgres (DATABASE_URL). Run `pnpm db:migrate && pnpm db:seed` first.
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { batches, executions, opportunities } from "@/db/schema";
import { createApprovalBatch } from "@/server/batches";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("approval batches", () => {
  const created: string[] = [];

  it("duplicate approve submissions create exactly one batch", async () => {
    const recs = await db.select().from(opportunities).where(eq(opportunities.status, "recommended")).limit(5);
    const clientId = recs[0]!.clientId;
    const ids = recs.filter((r) => r.clientId === clientId).slice(0, 2).map((r) => r.id);
    const key = crypto.randomUUID();
    const input = { clientId, opportunityIds: ids, idempotencyKey: key, undoWindowSeconds: 120 };

    // Fired concurrently, as a double tap would.
    const [a, b, c] = await Promise.all([createApprovalBatch(input), createApprovalBatch(input), createApprovalBatch(input)]);
    created.push(a.batch.id);
    expect(new Set([a.batch.id, b.batch.id, c.batch.id]).size).toBe(1);
    expect([a, b, c].filter((r) => !r.duplicate)).toHaveLength(1);

    const rows = await db.select().from(batches).where(eq(batches.idempotencyKey, key));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending_start");
    const execs = await db.select().from(executions).where(eq(executions.batchId, rows[0]!.id));
    expect(execs).toHaveLength(ids.length);
    expect(execs.every((e) => e.status === "queued")).toBe(true);
  });

  it("a second key for already-approved items creates no executions", async () => {
    const [b] = await db.select().from(batches).where(eq(batches.id, created[0]!));
    const opps = await db.select().from(opportunities).where(and(eq(opportunities.batchId, b!.id)));
    const res = await createApprovalBatch({
      clientId: b!.clientId,
      opportunityIds: opps.map((o) => o.id),
      idempotencyKey: crypto.randomUUID(),
      undoWindowSeconds: 120,
    });
    expect(res.count).toBe(0);
  });

  afterAll(async () => {
    // Put the seed data back the way it was.
    for (const id of created) {
      await db.delete(executions).where(eq(executions.batchId, id));
      await db.update(opportunities).set({ status: "recommended", batchId: null, decidedAt: null, decidedBy: null }).where(eq(opportunities.batchId, id));
    }
  });
});
