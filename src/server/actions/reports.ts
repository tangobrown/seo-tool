"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { clients, monthlyReports } from "@/db/schema";
import { previousPeriod } from "@/domain/schedule";
import { audit } from "@/lib/audit";
import { requireSession } from "@/lib/auth";
import { resolveAttention } from "@/lib/attention";
import { periodOf } from "@/lib/format";
import { generateMonthlyReport } from "@/server/reports";
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

/** Generates last month's report now (normally done on the 1st). Never creates a second one. */
export async function generateReportNow(clientId: string): Promise<ActionResult<{ reportId: string }>> {
  await requireSession();
  if (!z.string().uuid().safeParse(clientId).success) return { ok: false, error: "Invalid request" };
  const [c] = await db.select({ status: clients.status }).from(clients).where(eq(clients.id, clientId));
  if (!c) return { ok: false, error: "Client not found" };
  if (c.status !== "active") return { ok: false, error: "Reports start once the client is active." };
  try {
    const res = await generateMonthlyReport(clientId, previousPeriod(periodOf(new Date())));
    if (!res.reportId) return { ok: false, error: res.reason ?? "Couldn’t generate the report" };
    revalidatePath(`/clients/${clientId}/reports`);
    revalidatePath("/", "layout");
    return { ok: true, reportId: res.reportId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "Couldn’t generate the report" };
  }
}
