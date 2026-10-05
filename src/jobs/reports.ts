import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { previousPeriod } from "@/domain/schedule";
import { finishRun, startRun } from "@/integrations/run";
import { appLink, notify } from "@/integrations/slack";
import { periodOf } from "@/lib/format";
import { generateMonthlyReport } from "@/server/reports";
import { EVENTS, inngest } from "./client";
import { onJobFailure } from "./failure";

/**
 * report.monthly (§12.1): 1st of the month, 07:00 London. One report per active client with
 * "Include in monthly report" on, for the previous calendar month. Idempotent per client and month,
 * so a retry or a re-run never creates a second report. One Slack message for the whole run.
 */
export const reportMonthly = inngest.createFunction(
  {
    id: "report-monthly",
    triggers: [{ cron: "TZ=Europe/London 0 7 1 * *" }, { event: EVENTS.reportMonthly }],
    retries: 3,
    onFailure: async ({ error }) => onJobFailure("report.monthly", error),
  },
  async ({ step }) => {
    const period = await step.run("period", () => previousPeriod(periodOf(new Date())));
    const ids = await step.run("find-clients", async () =>
      (
        await db
          .select({ id: clients.id })
          .from(clients)
          .where(and(eq(clients.status, "active"), eq(clients.includeInMonthlyReport, true), isNull(clients.archivedAt)))
      ).map((c) => c.id),
    );
    const runId = await step.run("start-run", () => startRun("report.monthly", null));

    let generated = 0;
    const failed: string[] = [];
    for (const clientId of ids) {
      // Each client is its own step: a failure for one doesn't block the others.
      const res = await step
        .run(`report-${clientId}`, () => generateMonthlyReport(clientId, period))
        .catch(async (e: unknown) => {
          await step.run(`report-failed-${clientId}`, () => onJobFailure("report.monthly", e, clientId, `${clientId}:${period}`));
          return null;
        });
      if (!res) failed.push(clientId);
      else if (res.status === "generated") generated++;
    }

    await step.run("finish-run", () => finishRun(runId, failed.length ? "failed" : "succeeded", { stats: { period, clients: ids.length, generated, failed: failed.length } }));
    if (generated) {
      await step.run("notify", () => notify("reports", `${generated} monthly report${generated === 1 ? "" : "s"} ready to review and send. ${appLink("/attention", "Open")}`));
    }
    return { period, generated, failed: failed.length };
  },
);
