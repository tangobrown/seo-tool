import "server-only";
import { z } from "zod";
import { checkLive, clientHasActiveJob, dispatchGithubBatch, finishVerification, reconcileJobs, verifyTargets } from "@/server/github-exec";
import { EVENTS, inngest } from "./client";
import { onJobFailure } from "./failure";

const startEvent = z.object({ batchId: z.string().uuid(), clientId: z.string().uuid(), executionIds: z.array(z.string().uuid()) });

/**
 * github.batch: waits until the client has no other GitHub job in flight (one at a time per client,
 * §11.1), then dispatches the workflow. Callbacks and webhooks drive it from there.
 */
export const githubBatch = inngest.createFunction(
  {
    id: "github-batch",
    triggers: [{ event: EVENTS.githubBatchStart }],
    concurrency: [{ key: "event.data.clientId", limit: 1 }],
    retries: 3,
    onFailure: async ({ event, error }) => {
      const d = startEvent.safeParse(event.data.event.data);
      await onJobFailure("github.batch", error, d.success ? d.data.clientId : null, d.success ? d.data.batchId : undefined);
    },
  },
  async ({ event, step }) => {
    const { batchId, clientId, executionIds } = startEvent.parse(event.data);
    for (let i = 0; i < 36; i++) {
      const busy = await step.run(`check-slot-${i}`, () => clientHasActiveJob(clientId, batchId));
      if (!busy) break;
      await step.sleep(`wait-for-slot-${i}`, "5m");
    }
    return step.run("dispatch", () => dispatchGithubBatch(batchId, executionIds));
  },
);

/** deployment.verify: after merge, poll the live URLs every 2 minutes for up to 30 minutes. */
export const deploymentVerify = inngest.createFunction(
  { id: "deployment-verify", triggers: [{ event: EVENTS.deploymentVerify }], concurrency: [{ key: "event.data.batchId", limit: 1 }] },
  async ({ event, step }) => {
    const { batchId } = z.object({ batchId: z.string().uuid() }).parse(event.data);
    for (let i = 0; i < 15; i++) {
      await step.sleep(`wait-${i}`, "2m");
      const remaining = await step.run(`check-${i}`, async () => {
        const targets = await verifyTargets(batchId);
        const results = await Promise.all(targets.map(async (t) => ({ ...t, ...(await checkLive(t.url)) })));
        await finishVerification(batchId, results, i === 14);
        return results.filter((r) => !r.ok).length;
      });
      if (remaining === 0) return { verified: true, attempts: i + 1 };
    }
    return { verified: false };
  },
);

/** github.reconcile: catches jobs whose callbacks stopped (lost, or the run died). */
export const githubReconcile = inngest.createFunction(
  { id: "github-reconcile", triggers: [{ cron: "TZ=Europe/London */10 * * * *" }] },
  async ({ step }) => step.run("reconcile", () => reconcileJobs()),
);
