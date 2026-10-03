"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { attentionItems } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireSession } from "@/lib/auth";
import { setExecutionStatus } from "@/server/execution";
import type { ActionResult } from "./recommendations";

/** Only manual-action items resolve by hand; everything else resolves when its condition clears. */
export async function markAttentionDone(id: string): Promise<ActionResult> {
  await requireSession();
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: "Invalid request" };
  const [item] = await db.select().from(attentionItems).where(eq(attentionItems.id, id));
  if (!item || item.status !== "open") return { ok: false, error: "Already resolved" };
  if (item.kind !== "manual_action") return { ok: false, error: "This item resolves automatically." };
  await db
    .update(attentionItems)
    .set({ status: "resolved", resolvedAt: new Date() })
    .where(and(eq(attentionItems.id, id), eq(attentionItems.status, "open")));
  const executionId = typeof item.meta?.executionId === "string" ? item.meta.executionId : null;
  if (executionId) await setExecutionStatus([executionId], "live", { actor: "operator" });
  await audit({ actor: "operator", clientId: item.clientId, entityType: "attention_item", entityId: id, event: "attention.marked_done", after: { title: item.title } });
  revalidatePath("/", "layout");
  return { ok: true };
}
