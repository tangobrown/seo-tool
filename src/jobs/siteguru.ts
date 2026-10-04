import "server-only";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { finishRun, startRun } from "@/integrations/run";
import { notifySyncFailure, syncClientFromSiteguru } from "@/server/siteguru-sync";
import { EVENTS, inngest } from "./client";

const data = z.object({ clientId: z.string().uuid() });

/** siteguru.sync.daily (05:00 Europe/London): fans out one sync per linked, non-paused client. */
export const siteguruSyncDaily = inngest.createFunction(
  { id: "siteguru-sync-daily", triggers: [{ cron: "TZ=Europe/London 0 5 * * *" }] },
  async ({ step }) => {
    const ids = await step.run("find-clients", async () =>
      (
        await db
          .select({ id: clients.id })
          .from(clients)
          .where(and(isNotNull(clients.siteguruSiteId), isNull(clients.archivedAt), eq(clients.paused, false)))
      ).map((c) => c.id),
    );
    const day = new Date().toISOString().slice(0, 10);
    if (ids.length) {
      await step.sendEvent(
        "fan-out",
        ids.map((clientId) => ({ name: EVENTS.siteguruSyncClient, data: { clientId }, id: `sg-${clientId}-${day}` })),
      );
    }
    return { clients: ids.length };
  },
);

export const siteguruSyncClient = inngest.createFunction(
  {
    id: "siteguru-sync-client",
    triggers: [{ event: EVENTS.siteguruSyncClient }],
    concurrency: [{ key: "event.data.clientId", limit: 1 }],
    retries: 3,
    onFailure: async ({ error }) => {
      // The connection error and the aggregate attention item were recorded by the sync itself.
      await notifySyncFailure(error.message);
    },
  },
  async ({ event, step }) => {
    const { clientId } = data.parse(event.data);
    return step.run("sync", async () => {
      const runId = await startRun("siteguru.sync", clientId);
      try {
        const out = await syncClientFromSiteguru(clientId);
        await finishRun(runId, "succeeded", { stats: out });
        return out;
      } catch (e) {
        await finishRun(runId, "failed", { error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    });
  },
);
