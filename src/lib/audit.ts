import "server-only";
import { db, type Tx } from "@/db";
import { auditLog } from "@/db/schema";

export type AuditActor = "operator" | "system" | "claude_code" | "webhook";

export type AuditEntry = {
  actor: AuditActor;
  clientId?: string | null;
  entityType: string;
  entityId?: string | null;
  event: string;
  before?: unknown;
  after?: unknown;
  meta?: unknown;
};

export async function audit(entry: AuditEntry, tx?: Tx) {
  await (tx ?? db).insert(auditLog).values({
    actor: entry.actor,
    clientId: entry.clientId ?? null,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    event: entry.event,
    before: entry.before ?? null,
    after: entry.after ?? null,
    meta: entry.meta ?? null,
  });
}
