import "server-only";
import { and, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { finishRun, startRun } from "@/integrations/run";
import { notify } from "@/integrations/slack";
import { syncClientFromGsc } from "@/server/gsc-sync";
import { EVENTS, inngest } from "./client";

const data = z.object({ clientId: z.string().uuid() });

/** gsc.sync.daily (05:15 Europe/London): one Search Console sync per linked, non-archived client. */
export const gscSyncDaily = inngest.createFunction(
  { id: "gsc-sync-daily", triggers: [{ cron: "TZ=Europe/London 15 5 * * *" }] },
  async ({ step }) => {
    const ids = await step.run("find-clients", async () =>
      (await db.select({ id: clients.id }).from(clients).where(and(isNotNull(clients.gscProperty), isNull(clients.archivedAt)))).map((c) => c.id),
    );
    const day = new Date().toISOString().slice(0, 10);
    if (ids.length) {
      await step.sendEvent("fan-out", ids.map((clientId) => ({ name: EVENTS.gscSyncClient, data: { clientId }, id: `gsc-${clientId}-${day}` })));
    }
    return { clients: ids.length };
  },
);

export const gscSyncClient = inngest.createFunction(
  {
    id: "gsc-sync-client",
    triggers: [{ event: EVENTS.gscSyncClient }],
    concurrency: [{ key: "event.data.clientId", limit: 1 }],
    retries: 3,
    // The sync itself records the connection error and the attention item.
    onFailure: async ({ error }) => notify("failures", `:warning: Search Console sync failed: ${error.message.slice(0, 200)}`),
  },
  async ({ event, step }) => {
    const { clientId } = data.parse(event.data);
    return step.run("sync", async () => {
      const runId = await startRun("gsc.sync", clientId);
      try {
        const out = await syncClientFromGsc(clientId);
        await finishRun(runId, "succeeded", { stats: out });
        return out;
      } catch (e) {
        await finishRun(runId, "failed", { error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    });
  },
);
