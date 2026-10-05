import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { finishRun, startRun } from "@/integrations/run";
import { periodOf } from "@/lib/format";
import { checkBlogCommitment, draftBlogWave, planBlogPosts } from "@/server/blog";
import { EVENTS, inngest } from "./client";
import { onJobFailure } from "./failure";

const clientEvent = z.object({ clientId: z.string().uuid() });

async function activeClientIds() {
  return (
    await db
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.status, "active"), eq(clients.paused, false), isNull(clients.archivedAt)))
  ).map((c) => c.id);
}

/** blog.plan for one client: tops the month up to N evidenced topics (§10.6). */
export const blogPlanClient = inngest.createFunction(
  {
    id: "blog-plan-client",
    triggers: [{ event: EVENTS.blogPlanClient }],
    concurrency: [{ key: "event.data.clientId", limit: 1 }],
    retries: 3,
    onFailure: async ({ event, error }) => {
      const d = clientEvent.safeParse(event.data.event.data);
      await onJobFailure("blog.plan", error, d.success ? d.data.clientId : null);
    },
  },
  async ({ event, step }) => {
    const { clientId } = clientEvent.parse(event.data);
    const period = await step.run("period", () => periodOf(new Date()));
    const runId = await step.run("start-run", () => startRun("blog.plan", clientId));
    const plan = await step.run("plan", () => planBlogPosts(clientId, period));
    // Draft the first wave straight away so the month doesn't start empty.
    if (plan.added) await step.sendEvent("first-wave", { name: EVENTS.blogDraftClient, data: { clientId }, id: `blog-draft-${clientId}-${period}-first` });
    await step.run("finish-run", () => finishRun(runId, "succeeded", { stats: { period, ...plan } }));
    return plan;
  },
);

/** blog.plan schedule: 1st of the month, 08:00 London (after reports). */
export const blogPlanMonthly = inngest.createFunction(
  { id: "blog-plan-monthly", triggers: [{ cron: "TZ=Europe/London 0 8 1 * *" }] },
  async ({ step }) => {
    const ids = await step.run("find-clients", activeClientIds);
    const period = periodOf(new Date());
    if (ids.length) {
      await step.sendEvent("fan-out", ids.map((clientId) => ({ name: EVENTS.blogPlanClient, data: { clientId }, id: `blog-plan-${clientId}-${period}` })));
    }
    return { clients: ids.length };
  },
);

/** blog.draft_wave for one client. */
export const blogDraftClient = inngest.createFunction(
  {
    id: "blog-draft-client",
    triggers: [{ event: EVENTS.blogDraftClient }],
    concurrency: [{ key: "event.data.clientId", limit: 1 }],
    retries: 3,
    onFailure: async ({ event, error }) => {
      const d = clientEvent.safeParse(event.data.event.data);
      await onJobFailure("blog.draft_wave", error, d.success ? d.data.clientId : null);
    },
  },
  async ({ event, step }) => {
    const { clientId } = clientEvent.parse(event.data);
    const runId = await step.run("start-run", () => startRun("blog.draft_wave", clientId));
    const wave = await step.run("draft", () => draftBlogWave(clientId));
    if (wave.autoBatchId) {
      await step.sendEvent("dispatch-auto-batch", { name: EVENTS.batchApproved, data: { batchId: wave.autoBatchId, clientId }, id: `batch-${wave.autoBatchId}` });
    }
    await step.run("finish-run", () => finishRun(runId, "succeeded", { stats: { ...wave } }));
    return wave;
  },
);

/** blog.draft_wave schedule: weekly, Monday 09:00 London (after the scan). */
export const blogDraftWeekly = inngest.createFunction(
  { id: "blog-draft-weekly", triggers: [{ cron: "TZ=Europe/London 0 9 * * 1" }] },
  async ({ step }) => {
    const ids = await step.run("find-clients", activeClientIds);
    const day = new Date().toISOString().slice(0, 10);
    if (ids.length) {
      await step.sendEvent("fan-out", ids.map((clientId) => ({ name: EVENTS.blogDraftClient, data: { clientId }, id: `blog-draft-${clientId}-${day}` })));
    }
    return { clients: ids.length };
  },
);

/** blog.commitment_check: daily 09:30 London. Raises or clears the behind-schedule item per client. */
export const blogCommitmentCheck = inngest.createFunction(
  {
    id: "blog-commitment-check",
    triggers: [{ cron: "TZ=Europe/London 30 9 * * *" }],
    retries: 3,
    onFailure: async ({ error }) => onJobFailure("blog.commitment_check", error),
  },
  async ({ step }) => {
    const ids = await step.run("find-clients", activeClientIds);
    const results = await step.run("check", async () => {
      let behind = 0;
      for (const id of ids) if ((await checkBlogCommitment(id)).behind) behind++;
      return { behind };
    });
    return { clients: ids.length, ...results };
  },
);

/** A newly activated client gets this month's posts planned straight away. */
export const blogPlanOnActivation = inngest.createFunction(
  { id: "blog-plan-on-activation", triggers: [{ event: EVENTS.clientActivated }] },
  async ({ event, step }) => {
    const { clientId } = clientEvent.parse(event.data);
    // Wait for the first scan to capture SiteGuru signals; topics come from them.
    await step.sleep("after-first-scan", "30m");
    await step.sendEvent("plan", { name: EVENTS.blogPlanClient, data: { clientId }, id: `blog-plan-${clientId}-${periodOf(new Date())}-activation` });
  },
);
