import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { previousPeriod } from "@/domain/schedule";
import { finishRun, startRun } from "@/integrations/run";
import { appLink, notify } from "@/integrations/slack";
import { periodOf } from "@/lib/format";
import { londonDayInfo } from "@/domain/blog";
import { usesGsc } from "@/server/gsc-sync";
import { generateMonthlyReport, monthMetrics } from "@/server/reports";
import { EVENTS, inngest } from "./client";
import { onJobFailure } from "./failure";

/**
 * report.monthly (§12.1): 07:00 London on the 1st–5th. One report per active client with
 * "Include in monthly report" on, for the previous calendar month. Search Console reports a few days
 * behind, so a client with Search Console waits until the whole month is in (usually the 3rd); on the
 * 5th the report goes out regardless, using the latest 30 days. Idempotent per client and month, so
 * the daily re-runs never create a second report. One Slack message per run that produced reports.
 */
export const reportMonthly = inngest.createFunction(
  {
    id: "report-monthly",
    triggers: [{ cron: "TZ=Europe/London 0 7 1-5 * *" }, { event: EVENTS.reportMonthly }],
    retries: 3,
    onFailure: async ({ error }) => onJobFailure("report.monthly", error),
  },
  async ({ step }) => {
    const { period, finalDay } = await step.run("period", () => ({ period: previousPeriod(periodOf(new Date())), finalDay: londonDayInfo(new Date()).dayOfMonth >= 5 }));
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
    let waiting = 0;
    const failed: string[] = [];
    for (const clientId of ids) {
      // Each client is its own step: a failure for one doesn't block the others.
      const res = await step
        .run(`report-${clientId}`, async () => {
          if (!finalDay && (await usesGsc(clientId)) && !(await monthMetrics(clientId, period))) {
            return { status: "waiting" as const };
          }
          return generateMonthlyReport(clientId, period);
        })
        .catch(async (e: unknown) => {
          await step.run(`report-failed-${clientId}`, () => onJobFailure("report.monthly", e, clientId, `${clientId}:${period}`));
          return null;
        });
      if (!res) failed.push(clientId);
      else if (res.status === "generated") generated++;
      else if (res.status === "waiting") waiting++;
    }

    await step.run("finish-run", () => finishRun(runId, failed.length ? "failed" : "succeeded", { stats: { period, clients: ids.length, generated, waiting, failed: failed.length } }));
    if (generated) {
      await step.run("notify", () => notify("reports", `${generated} monthly report${generated === 1 ? "" : "s"} ready to review and send. ${appLink("/attention", "Open")}`));
    }
    return { period, generated, waiting, failed: failed.length };
  },
);
