import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { attentionItems } from "@/db/schema";

type Kind = (typeof attentionItems.$inferInsert)["kind"];

export type AttentionInput = {
  dedupeKey: string;
  kind: Kind;
  clientId?: string | null;
  title: string;
  detail?: string;
  link?: string | null;
  meta?: Record<string, unknown>;
};

/**
 * Opens (or re-opens and refreshes) an attention item. The dedupe key means one
 * condition can never appear twice.
 */
export async function raiseAttention(input: AttentionInput, tx?: Tx) {
  await (tx ?? db)
    .insert(attentionItems)
    .values({
      dedupeKey: input.dedupeKey,
      kind: input.kind,
      clientId: input.clientId ?? null,
      title: input.title,
      detail: input.detail ?? "",
      link: input.link ?? null,
      meta: input.meta ?? null,
    })
    .onConflictDoUpdate({
      target: attentionItems.dedupeKey,
      set: {
        title: input.title,
        detail: input.detail ?? "",
        link: input.link ?? null,
        meta: input.meta ?? null,
        status: "open",
        resolvedAt: null,
        createdAt: sql`case when ${attentionItems.status} = 'resolved' then now() else ${attentionItems.createdAt} end`,
      },
    });
}

export async function resolveAttention(dedupeKey: string, tx?: Tx) {
  await (tx ?? db)
    .update(attentionItems)
    .set({ status: "resolved", resolvedAt: new Date() })
    .where(and(eq(attentionItems.dedupeKey, dedupeKey), eq(attentionItems.status, "open")));
}
