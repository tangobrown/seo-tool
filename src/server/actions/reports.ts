"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { monthlyReports } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireSession } from "@/lib/auth";
import { resolveAttention } from "@/lib/attention";
import type { ActionResult } from "./recommendations";

export async function markReportRead(reportId: string): Promise<ActionResult> {
  await requireSession();
  if (!z.string().uuid().safeParse(reportId).success) return { ok: false, error: "Invalid request" };
  const [r] = await db
    .update(monthlyReports)
    .set({ readAt: new Date(), status: "read" })
    .where(and(eq(monthlyReports.id, reportId), isNull(monthlyReports.readAt), eq(monthlyReports.status, "generated")))
    .returning();
  if (r) revalidatePath(`/clients/${r.clientId}/reports`);
  return { ok: true };
}

export async function markReportSent(reportId: string): Promise<ActionResult<{ sentAt: string }>> {
  await requireSession();
  if (!z.string().uuid().safeParse(reportId).success) return { ok: false, error: "Invalid request" };
  const sentAt = new Date();
  const [r] = await db
    .update(monthlyReports)
    .set({ status: "sent", sentAt, readAt: sentAt })
    .where(eq(monthlyReports.id, reportId))
    .returning();
  if (!r) return { ok: false, error: "Report not found" };
  await resolveAttention(`report_ready:${r.clientId}:${r.period}`);
  await audit({ actor: "operator", clientId: r.clientId, entityType: "monthly_report", entityId: r.id, event: "report.marked_sent", after: { period: r.period } });
  revalidatePath("/", "layout");
  return { ok: true, sentAt: sentAt.toISOString() };
}
