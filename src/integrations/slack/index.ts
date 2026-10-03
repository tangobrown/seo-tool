import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { workspace, type NotificationPrefs } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { callProvider } from "../run";
import type { NotificationProvider } from "../types";

export function slackProvider(webhookUrl: string): NotificationProvider {
  return {
    async send(text) {
      await callProvider("slack", "send", async (signal) => {
        const res = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          signal,
        });
        if (!res.ok) throw new Error(`Slack returned ${res.status}`);
      });
    },
  };
}

/** Sends only if the workspace has a webhook and the matching toggle is on. Never throws. */
export async function notify(kind: keyof NotificationPrefs, text: string): Promise<void> {
  try {
    const [ws] = await db.select().from(workspace).where(eq(workspace.id, 1));
    if (!ws?.slackWebhookUrlEnc || !ws.notifications[kind]) return;
    await slackProvider(decrypt(ws.slackWebhookUrlEnc)).send(text);
  } catch (e) {
    console.error("Slack notification failed", e);
  }
}

export function appLink(path: string, label: string): string {
  const base = process.env.APP_URL ?? "";
  return `<${base}${path}|${label}>`;
}
