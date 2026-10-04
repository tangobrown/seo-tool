import "server-only";
import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { batches, clients, executions, opportunities } from "@/db/schema";
import { audit } from "@/lib/audit";
import { raiseAttention } from "@/lib/attention";
import { notify, appLink } from "@/integrations/slack";
import { setExecutionStatus } from "@/server/execution";
import { EVENTS, inngest } from "./client";
import { onJobFailure } from "./failure";

const batchEvent = z.object({ batchId: z.string().uuid(), clientId: z.string().uuid() });

export const batchDispatch = inngest.createFunction(
  {
    id: "batch-dispatch",
    triggers: [{ event: EVENTS.batchApproved }],
    retries: 3,
    onFailure: async ({ event, error }) => {
      const data = batchEvent.safeParse(event.data.event.data);
      await onJobFailure("batch.dispatch", error, data.success ? data.data.clientId : null, data.success ? data.data.batchId : undefined);
    },
  },
  async ({ event, step }) => {
    const { batchId, clientId } = batchEvent.parse(event.data);

    const startsAt = await step.run("load-batch", async () => {
      const [b] = await db.select().from(batches).where(eq(batches.id, batchId));
      return b ? b.startsAt.toISOString() : null;
    });
    if (!startsAt) return { skipped: "batch not found" };

    await step.sleepUntil("undo-window", new Date(startsAt));

    // Atomic claim: only a batch still pending_start proceeds. Undo after this point is impossible.
    const claimed = await step.run("claim", async () => {
      const rows = await db
        .update(batches)
        .set({ status: "running", startedAt: new Date() })
        .where(and(eq(batches.id, batchId), eq(batches.status, "pending_start")))
        .returning();
      if (rows[0]) {
        await audit({ actor: "system", clientId: rows[0].clientId, entityType: "batch", entityId: batchId, event: "batch.started" });
      }
      return !!rows[0];
    });
    if (!claimed) return { skipped: "batch no longer pending" };

    const split = await step.run("split-executions", async () => {
      const rows = await db
        .select({ exec: executions, opp: opportunities, clientName: clients.name, clientId: clients.id })
        .from(executions)
        .innerJoin(opportunities, eq(opportunities.id, executions.opportunityId))
        .innerJoin(clients, eq(clients.id, opportunities.clientId))
        .where(and(eq(executions.batchId, batchId), eq(executions.status, "queued")));

      // GBP writes arrive in Phase 6; until then they're manual checklists too.
      const manual = rows.filter((r) => ["manual_action", "outreach_draft", "gbp_api"].includes(r.exec.executionType));
      for (const r of manual) {
        await raiseAttention({
          dedupeKey: `manual:${r.exec.id}`,
          kind: "manual_action",
          clientId: r.clientId,
          title: `${r.opp.title} (manual)`,
          detail: r.opp.proposedAction,
          link: `/clients/${r.clientId}/actioned`,
          meta: { executionId: r.exec.id, checklist: checklistFor(r.opp.proposedAction) },
        });
      }
      await setExecutionStatus(manual.map((r) => r.exec.id), "action_needed", { actor: "system" });
      if (manual.length) {
        await notify("failures", `${manual.length} manual action${manual.length === 1 ? "" : "s"} for ${manual[0]!.clientName}: ${appLink("/attention", "Open")}`);
      }
      const automated = rows.filter((r) => !manual.includes(r)).map((r) => r.exec.id);
      return { automated };
    });

    if (split.automated.length) {
      if (process.env.EXECUTION_MODE === "fake") {
        // Local development and demos: simulate statuses instead of running Claude Code.
        await step.sendEvent("start-fake-executor", { name: EVENTS.fakeExecutorStart, data: { batchId, executionIds: split.automated }, id: `fake-${batchId}` });
      } else {
        // §11.2: one GitHub job for the whole batch (Claude Code in the client repo's Actions).
        await step.sendEvent("start-github", {
          name: EVENTS.githubBatchStart,
          data: { batchId, clientId, executionIds: split.automated },
          id: `github-${batchId}`,
        });
      }
    }
    return { automated: split.automated.length };
  },
);

function checklistFor(action: string): string[] {
  return [action, "Check the change is live", "Tap Mark done here"];
}

/** Safety net: re-sends batch.approved for any batch whose event was lost. Event IDs dedupe. */
export const batchSweep = inngest.createFunction(
  { id: "batch-sweep", triggers: [{ cron: "TZ=Europe/London */5 * * * *" }] },
  async ({ step }) => {
    const stuck = await step.run("find-stuck", async () =>
      db
        .select({ id: batches.id, clientId: batches.clientId })
        .from(batches)
        .where(and(eq(batches.status, "pending_start"), lt(batches.startsAt, new Date(Date.now() - 2 * 60_000)))),
    );
    if (stuck.length) {
      await step.sendEvent(
        "resend",
        stuck.map((b) => ({ name: EVENTS.batchApproved, data: { batchId: b.id, clientId: b.clientId }, id: `batch-${b.id}` })),
      );
    }
    return { resent: stuck.length };
  },
);
