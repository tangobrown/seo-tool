import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { batches, clients, executions, githubJobs } from "@/db/schema";
import { raiseAttention, resolveAttention } from "@/lib/attention";
import { setExecutionStatus } from "@/server/execution";
import { EVENTS, inngest } from "./client";
import { onJobFailure } from "./failure";

/**
 * FakeExecutor (Phase 1): walks executions through queued → running → PR ready → merged → live so the
 * approval loop can be tested end to end. Delays are short so a reviewer can watch it happen.
 */
const data = z.object({ batchId: z.string().uuid(), executionIds: z.array(z.string().uuid()) });
const delay = (s: number) => `${Math.max(1, Math.round(s * Number(process.env.FAKE_EXECUTOR_SPEED ?? 1)))}s`;

export const fakeExecutor = inngest.createFunction(
  {
    id: "fake-executor",
    triggers: [{ event: EVENTS.fakeExecutorStart }],
    onFailure: async ({ event, error }) => {
      const d = data.safeParse(event.data.event.data);
      await onJobFailure("fake-executor", error, null, d.success ? d.data.batchId : undefined);
    },
  },
  async ({ event, step }) => {
    const { batchId, executionIds } = data.parse(event.data);
    const live = async () =>
      (await db.select({ id: executions.id }).from(executions).where(and(inArray(executions.id, executionIds), inArray(executions.status, ["queued", "running", "pr_ready", "merged"])))).map((r) => r.id);

    await step.sleep("pickup", delay(5));
    await step.run("running", async () => setExecutionStatus(await live(), "running", { actor: "claude_code" }));

    await step.sleep("claude-code", delay(20));
    await step.run("pr-opened", async () => {
      const [b] = await db
        .select({ batch: batches, client: clients })
        .from(batches)
        .innerJoin(clients, eq(clients.id, batches.clientId))
        .where(eq(batches.id, batchId));
      if (!b) return;
      const prNumber = 100 + Math.floor(Math.random() * 800);
      const repo = b.client.githubRepo ?? "example/repo";
      const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
      const ids = await live();
      await db.insert(githubJobs).values({
        batchId,
        clientId: b.client.id,
        repo,
        branch: `seo-autopilot/batch-${batchId.slice(0, 8)}`,
        prNumber,
        prUrl,
        status: "pr_opened",
      });
      await setExecutionStatus(ids, "pr_ready", { actor: "claude_code", result: { prNumber, prUrl, fake: true } });
      await raiseAttention({
        dedupeKey: `pr_review:${batchId}`,
        kind: "pr_review",
        clientId: b.client.id,
        title: `PR #${prNumber} ready — ${ids.length} change${ids.length === 1 ? "" : "s"} for ${b.client.name}`,
        detail: "Simulated by the FakeExecutor. QA passed.",
        link: prUrl,
        meta: { batchId },
      });
    });

    await step.sleep("review", delay(30));
    await step.run("merged", async () => {
      await setExecutionStatus(await live(), "merged", { actor: "webhook" });
      await db.update(githubJobs).set({ mergedAt: new Date(), status: "merged" }).where(eq(githubJobs.batchId, batchId));
      await resolveAttention(`pr_review:${batchId}`);
    });

    await step.sleep("verify", delay(10));
    await step.run("live", async () => {
      await setExecutionStatus(await live(), "live", { actor: "system" });
      await db.update(githubJobs).set({ verifiedAt: new Date(), status: "verified" }).where(eq(githubJobs.batchId, batchId));
    });
  },
);
