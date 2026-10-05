import "server-only";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { clients, executions, metricSnapshots, monthlyReports, opportunities, tiers, workspace, type SiteMetrics } from "@/db/schema";
import { reportEmailHtml, reportEmailText, reportSubject } from "@/domain/report-email";
import { buildSections, nextBullets, pctChange, performanceBullets, templateSummary, workBullets, type ReportInput } from "@/domain/report";
import { londonMonthBounds, previousPeriod } from "@/domain/schedule";
import { onlyKnownNumbers } from "@/domain/opportunities/text";
import { anthropicConfigured, llmJson } from "@/integrations/anthropic";
import { REPORT_PROMPT_VERSION, REPORT_SYSTEM, reportPrompt, reportTextSchema } from "@/integrations/anthropic/prompts/report";
import { audit } from "@/lib/audit";
import { raiseAttention } from "@/lib/attention";
import { formatDate, formatMonthYear } from "@/lib/format";

function utcMonthStart(period: string) {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1));
}

async function monthMetrics(clientId: string, period: string): Promise<SiteMetrics | null> {
  const [row] = await db
    .select({ metrics: metricSnapshots.metrics })
    .from(metricSnapshots)
    .where(
      and(
        eq(metricSnapshots.clientId, clientId),
        eq(metricSnapshots.source, "siteguru"),
        eq(metricSnapshots.kind, "month"),
        eq(metricSnapshots.periodStart, utcMonthStart(period)),
      ),
    );
  return row?.metrics ?? null;
}

/**
 * Verified metrics only (§12.1): the calendar month vs the month before from monthly snapshots.
 * Google search data lags a few days, so on the 1st the month may not be cached yet; then the latest
 * rolling 30 days is used and labelled with its exact window. Nothing at all → no performance section.
 */
export async function reportMetrics(clientId: string, period: string): Promise<ReportInput["metrics"]> {
  const [curr, prev] = await Promise.all([monthMetrics(clientId, period), monthMetrics(clientId, previousPeriod(period))]);
  if (curr && (curr.clicks != null || curr.impressions != null)) {
    return {
      source: "month",
      window: formatMonthYear(period),
      clicks: curr.clicks ?? null,
      prevClicks: prev?.clicks ?? null,
      impressions: curr.impressions ?? null,
      prevImpressions: prev?.impressions ?? null,
    };
  }
  const [rolling] = await db
    .select()
    .from(metricSnapshots)
    .where(and(eq(metricSnapshots.clientId, clientId), eq(metricSnapshots.source, "siteguru"), eq(metricSnapshots.kind, "rolling30")))
    .orderBy(desc(metricSnapshots.capturedAt))
    .limit(1);
  const m = rolling?.metrics;
  if (!rolling || !m || (m.clicks == null && m.impressions == null)) return null;
  // Only use a rolling window that mostly covers the report month.
  const { start, end } = londonMonthBounds(period);
  if (rolling.periodEnd < new Date(start.getTime() + 15 * 86400_000) || rolling.periodStart > end) return null;
  return {
    source: "rolling",
    window: `${formatDate(rolling.periodStart)} to ${formatDate(rolling.periodEnd)}`,
    clicks: m.clicks ?? null,
    prevClicks: m.prev?.clicks ?? null,
    impressions: m.impressions ?? null,
    prevImpressions: m.prev?.impressions ?? null,
  };
}

/** Completed work = executions that went live in the London calendar month (§12.1). */
export async function completedWork(clientId: string, period: string) {
  const { start, end } = londonMonthBounds(period);
  const rows = await db
    .selectDistinctOn([opportunities.id], { id: opportunities.id, title: opportunities.title, type: opportunities.type, finishedAt: executions.finishedAt })
    .from(executions)
    .innerJoin(opportunities, eq(opportunities.id, executions.opportunityId))
    .where(and(eq(opportunities.clientId, clientId), eq(executions.status, "live"), gte(executions.finishedAt, start), lt(executions.finishedAt, end)))
    .orderBy(opportunities.id);
  return rows.sort((a, b) => +new Date(a.finishedAt!) - +new Date(b.finishedAt!)).map((r) => ({ title: r.title, type: r.type }));
}

async function nextWork(clientId: string) {
  return db
    .select({ title: opportunities.title })
    .from(opportunities)
    .where(and(eq(opportunities.clientId, clientId), inArray(opportunities.status, ["recommended", "reserve", "approved"]), eq(opportunities.isBlogCommitment, false)))
    .orderBy(sql`case when ${opportunities.severity} = 'critical' then 0 else 1 end`, desc(opportunities.priorityScore))
    .limit(4);
}

type GenerateResult = { status: "generated" | "exists" | "skipped"; reportId?: string; reason?: string; textSource?: "llm" | "template" };

/**
 * report.monthly for one client (§12.1). Idempotent: one report per client and month; a second call
 * returns the existing report. Numbers come from code; the LLM only rewords the summary and bullets
 * and falls back to the factual template on any failure or if it adds a number.
 */
export async function generateMonthlyReport(clientId: string, period: string): Promise<GenerateResult> {
  const [existing] = await db
    .select({ id: monthlyReports.id })
    .from(monthlyReports)
    .where(and(eq(monthlyReports.clientId, clientId), eq(monthlyReports.period, period)));
  if (existing) return { status: "exists", reportId: existing.id };

  const [row] = await db.select({ c: clients, t: tiers }).from(clients).innerJoin(tiers, eq(tiers.id, clients.tierId)).where(eq(clients.id, clientId));
  if (!row) return { status: "skipped", reason: "Client not found" };
  const { c, t } = row;
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, 1));

  const periodLabel = formatMonthYear(period);
  const prevMonthName = formatMonthYear(previousPeriod(period)).split(" ")[0]!;
  const next = await nextWork(clientId);
  if (t.postsPerMonth > 0) next.push({ title: `Write and publish ${t.postsPerMonth} new blog post${t.postsPerMonth === 1 ? "" : "s"}` });
  const input: ReportInput = {
    periodLabel,
    prevMonthName,
    metrics: await reportMetrics(clientId, period),
    work: await completedWork(clientId, period),
    next,
  };

  const perf = performanceBullets(input);
  let summary = templateSummary(input, c.domain);
  let work = workBullets(input);
  let nextItems = nextBullets(input);
  let textSource: "llm" | "template" = "template";

  if (await anthropicConfigured()) {
    try {
      const out = await llmJson({
        schema: reportTextSchema,
        schemaName: "monthlyReport",
        system: REPORT_SYSTEM,
        prompt: reportPrompt({ client: { name: c.name, tone: c.brandTone }, periodLabel, facts: { summary, performance: perf, work, next: nextItems } }),
      });
      const facts = [summary, ...perf, ...work, ...nextItems, periodLabel];
      // Never hide a decline (§12.1): if clicks fell, the rewritten summary must still say so.
      const fell = (pctChange(input.metrics?.clicks ?? null, input.metrics?.prevClicks ?? null) ?? 0) < 0;
      const statesDecline = !fell || /\b(down|drop|dropped|fell|fewer|lower|decline|declined|decrease|decreased)\b/i.test(out.summary);
      if (statesDecline && onlyKnownNumbers([out.summary], facts)) {
        summary = out.summary;
        textSource = "llm";
      }
      if (out.what_we_did.length === work.length && onlyKnownNumbers(out.what_we_did, facts)) work = out.what_we_did;
      if (out.next_month.length === nextItems.length && onlyKnownNumbers(out.next_month, facts)) nextItems = out.next_month;
    } catch (e) {
      console.error("Report wording failed; using the factual template", e);
    }
  }

  const sections = buildSections(perf, work, nextItems);
  const signoff = ws?.signoff || ws?.senderName || "";
  const emailInput = { contactName: c.contactName, periodLabel, summary, sections, signoff };
  const [inserted] = await db
    .insert(monthlyReports)
    .values({
      clientId,
      period,
      summary,
      sections,
      metrics: { ...input.metrics, subject: reportSubject(periodLabel, c.name), textSource, promptVersion: textSource === "llm" ? REPORT_PROMPT_VERSION : null },
      emailText: reportEmailText(emailInput),
      emailHtml: reportEmailHtml(emailInput),
    })
    .onConflictDoNothing({ target: [monthlyReports.clientId, monthlyReports.period] })
    .returning({ id: monthlyReports.id });
  if (!inserted) {
    const [again] = await db.select({ id: monthlyReports.id }).from(monthlyReports).where(and(eq(monthlyReports.clientId, clientId), eq(monthlyReports.period, period)));
    return { status: "exists", reportId: again?.id };
  }

  await raiseAttention({
    dedupeKey: `report_ready:${clientId}:${period}`,
    kind: "report_ready",
    clientId,
    title: `${periodLabel.split(" ")[0]} report ready for ${c.name}`,
    detail: "Review it, copy it into an email and mark it sent.",
    link: `/clients/${clientId}/reports/${inserted.id}`,
  });
  await audit({
    actor: "system",
    clientId,
    entityType: "monthly_report",
    entityId: inserted.id,
    event: "report.generated",
    after: { period, textSource, work: input.work.length, metrics: input.metrics?.source ?? "none" },
  });
  return { status: "generated", reportId: inserted.id, textSource };
}
