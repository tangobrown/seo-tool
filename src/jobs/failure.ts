import "server-only";
import { notify } from "@/integrations/slack";
import { raiseAttention } from "@/lib/attention";

/** Final-failure handler shared by every job: attention item + Slack. Never fail silently. */
export async function onJobFailure(fnId: string, error: unknown, clientId?: string | null, key?: string) {
  const message = error instanceof Error ? error.message : String(error);
  await raiseAttention({
    dedupeKey: `job_failed:${fnId}:${key ?? clientId ?? "global"}`,
    kind: "failed",
    clientId: clientId ?? null,
    title: `Background job failed: ${fnId}`,
    detail: message.slice(0, 300),
    link: "/settings/activity",
  });
  await notify("failures", `:warning: ${fnId} failed: ${message.slice(0, 200)}`);
}
