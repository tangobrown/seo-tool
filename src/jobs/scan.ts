import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clients, tiers, workspace } from "@/db/schema";
import { isScanDue, londonParts } from "@/domain/schedule";
import { finishRun, startRun } from "@/integrations/run";
import { appLink, notify } from "@/integrations/slack";
import { autoApproveLowImpact, captureSignals, runDetection, writeRecommendationText } from "@/server/scan";
import { EVENTS, inngest } from "./client";
import { onJobFailure } from "./failure";

const scanEvent = z.object({ clientId: z.string().uuid(), trigger: z.enum(["schedule", "manual", "activation"]).default("manual"), scanKey: z.string().optional() });

/** client.scan (§10.1): sync → signals → detect → reconcile → score → select → wording → auto-approve. */
export const clientScan = inngest.createFunction(
  {
    id: "client-scan",
    triggers: [{ event: EVENTS.clientScan }],
    concurrency: [{ key: "event.data.clientId", limit: 1 }],
    retries: 3,
    onFailure: async ({ event, error }) => {
      const d = scanEvent.safeParse(event.data.event.data);
      await onJobFailure("client.scan", error, d.success ? d.data.clientId : null);
    },
  },
  async ({ event, step }) => {
    const { clientId, trigger } = scanEvent.parse(event.data);
    const scanKey = scanEvent.parse(event.data).scanKey ?? event.id ?? `${clientId}-${Date.now()}`;

    const eligible = await step.run("check-client", async () => {
      const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
      return !!c && c.status === "active" && !c.paused && !c.archivedAt;
    });
    if (!eligible) return { skipped: "Client is not active" };

    const runId = await step.run("start-run", () => startRun("client.scan", clientId));
    const signals = await step.run("capture-signals", () => captureSignals(clientId));
    const outcome = await step.run("detect-and-select", () => runDetection(clientId, signals.signalsId));
    const text = await step.run("write-text", () => writeRecommendationText(clientId));
    const auto = await step.run("auto-approve", () => autoApproveLowImpact(clientId, scanKey));
    if (auto) {
      await step.sendEvent("dispatch-auto-batch", { name: EVENTS.batchApproved, data: { batchId: auto.batchId, clientId }, id: `batch-${auto.batchId}` });
    }
    await step.run("finish-run", () =>
      finishRun(runId, "succeeded", {
        stats: { trigger, ...outcome, newlyRecommended: outcome.newlyRecommended.length, signalErrors: signals.errors, text, autoApproved: auto?.count ?? 0 },
      }),
    );
    return { newlyRecommended: outcome.newlyRecommended.length - (auto?.count ?? 0), recommended: outcome.recommended };
  },
);

/**
 * scan.schedule: runs hourly and acts only at the workspace scan day/time (Europe/London), so the
 * operator can change the time in Settings without a redeploy. One Slack message per run.
 */
export const scanSchedule = inngest.createFunction(
  { id: "scan-schedule", triggers: [{ cron: "TZ=Europe/London 0 * * * *" }] },
  async ({ step }) => {
    const due = await step.run("find-due-clients", async () => {
      const [ws] = await db.select().from(workspace).where(eq(workspace.id, 1));
      const now = londonParts(new Date());
      if (!ws || now.isoDay !== ws.scanDay || now.hhmm.slice(0, 2) !== ws.scanTime.slice(0, 2)) return { day: null, ids: [] as string[] };
      const rows = await db
        .select({ id: clients.id, createdAt: clients.createdAt, freq: tiers.scanFrequency })
        .from(clients)
        .innerJoin(tiers, eq(tiers.id, clients.tierId))
        .where(and(eq(clients.status, "active"), eq(clients.paused, false), isNull(clients.archivedAt)));
      return {
        day: now.date.toISOString().slice(0, 10),
        ids: rows.filter((r) => isScanDue(r.freq, now.date, new Date(r.createdAt))).map((r) => r.id),
      };
    });
    if (!due.day || !due.ids.length) return { scanned: 0 };

    const results = await Promise.all(
      due.ids.map((clientId) =>
        step
          .invoke(`scan-${clientId}`, { function: clientScan, data: { clientId, trigger: "schedule", scanKey: `${clientId}-${due.day}` } })
          .then((r) => ({ ok: true as const, n: "newlyRecommended" in r ? r.newlyRecommended : 0 }))
          .catch(() => ({ ok: false as const, n: 0 })),
      ),
    );
    const total = results.reduce((s, r) => s + r.n, 0);
    const clientsWithNew = results.filter((r) => r.n > 0).length;
    if (total > 0) {
      await step.run("notify", () =>
        notify(
          "newRecs",
          `${total} new recommendation${total === 1 ? "" : "s"} across ${clientsWithNew} client${clientsWithNew === 1 ? "" : "s"}. ${appLink("/", "Review")}`,
        ),
      );
    }
    return { scanned: due.ids.length, failed: results.filter((r) => !r.ok).length, newRecommendations: total };
  },
);

/** §9.1 step 10: the first scan runs as soon as the operator confirms a client. */
export const scanOnActivation = inngest.createFunction(
  { id: "scan-on-activation", triggers: [{ event: EVENTS.clientActivated }] },
  async ({ event, step }) => {
    const { clientId } = z.object({ clientId: z.string().uuid() }).parse(event.data);
    await step.sendEvent("scan", { name: EVENTS.clientScan, data: { clientId, trigger: "activation" }, id: `scan-activation-${clientId}` });
  },
);
