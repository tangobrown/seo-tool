import "server-only";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  attentionItems,
  auditLog,
  batches,
  blogCommitments,
  clientConnections,
  clients,
  executions,
  githubJobs,
  integrations,
  metricSnapshots,
  monthlyReports,
  opportunities,
  tiers,
  workspace,
  type SiteMetrics,
} from "@/db/schema";
import { periodOf } from "@/lib/format";

export async function getWorkspace() {
  const [w] = await db.select().from(workspace).where(eq(workspace.id, 1));
  if (w) return w;
  const [created] = await db.insert(workspace).values({ id: 1 }).onConflictDoNothing().returning();
  return created ?? (await db.select().from(workspace).where(eq(workspace.id, 1)))[0]!;
}

export async function getTiers() {
  return db.select().from(tiers).orderBy(asc(tiers.sortOrder));
}

const pendingCount = sql<number>`(select count(*)::int from ${opportunities} o where o.client_id = ${clients.id} and o.status = 'recommended')`;

export type ShellClient = { id: string; name: string; pending: number; status: string };

export async function getShellData() {
  const [ws, list, [attn], syncs] = await Promise.all([
    getWorkspace(),
    db
      .select({ id: clients.id, name: clients.name, status: clients.status, pending: pendingCount })
      .from(clients)
      .where(isNull(clients.archivedAt))
      .orderBy(asc(clients.name)),
    db.select({ n: sql<number>`count(*)::int` }).from(attentionItems).where(eq(attentionItems.status, "open")),
    db
      .select({ clientId: clientConnections.clientId, at: clientConnections.lastSuccessAt })
      .from(clientConnections)
      .where(and(eq(clientConnections.provider, "siteguru"), isNotNull(clientConnections.lastSuccessAt))),
  ]);
  const syncByClient: Record<string, string> = {};
  let latest: Date | null = null;
  for (const s of syncs) {
    if (!s.at) continue;
    syncByClient[s.clientId] = s.at.toISOString();
    if (!latest || s.at > latest) latest = s.at;
  }
  return {
    workspaceName: ws.name,
    clients: list as ShellClient[],
    attentionCount: attn?.n ?? 0,
    latestSync: latest?.toISOString() ?? null,
    syncByClient,
  };
}

export async function getDashboard(showArchived: boolean) {
  const rows = await db
    .select({
      id: clients.id,
      name: clients.name,
      domain: clients.domain,
      status: clients.status,
      paused: clients.paused,
      archivedAt: clients.archivedAt,
      tier: tiers.name,
      pending: pendingCount,
      lastReport: sql<Date | null>`(select max(generated_at) from ${monthlyReports} r where r.client_id = ${clients.id})`,
    })
    .from(clients)
    .innerJoin(tiers, eq(tiers.id, clients.tierId))
    .where(showArchived ? isNotNull(clients.archivedAt) : isNull(clients.archivedAt))
    .orderBy(asc(clients.name));

  const ids = rows.map((r) => r.id);
  const snaps = ids.length
    ? await db
        .selectDistinctOn([metricSnapshots.clientId], { clientId: metricSnapshots.clientId, metrics: metricSnapshots.metrics })
        .from(metricSnapshots)
        .where(and(inArray(metricSnapshots.clientId, ids), eq(metricSnapshots.source, "siteguru"), eq(metricSnapshots.kind, "rolling30")))
        .orderBy(metricSnapshots.clientId, desc(metricSnapshots.capturedAt))
    : [];
  const snapBy = new Map(snaps.map((s) => [s.clientId, s.metrics]));
  const [archived] = await db.select({ n: sql<number>`count(*)::int` }).from(clients).where(isNotNull(clients.archivedAt));
  return {
    clients: rows.map((r) => ({ ...r, metrics: snapBy.get(r.id) ?? null })),
    archivedCount: archived?.n ?? 0,
  };
}

export async function getClient(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db
    .select({ client: clients, tier: tiers })
    .from(clients)
    .innerJoin(tiers, eq(tiers.id, clients.tierId))
    .where(eq(clients.id, id));
  if (!row) return null;
  const [pending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(opportunities)
    .where(and(eq(opportunities.clientId, id), eq(opportunities.status, "recommended")));
  const [commitment] = await db
    .select()
    .from(blogCommitments)
    .where(and(eq(blogCommitments.clientId, id), eq(blogCommitments.period, periodOf(new Date()))));
  return { ...row, pending: pending?.n ?? 0, commitment: commitment ?? null };
}

export async function getRecommendations(clientId: string) {
  return db
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.clientId, clientId), eq(opportunities.status, "recommended")))
    .orderBy(desc(opportunities.priorityScore), asc(opportunities.title));
}

export async function getActioned(clientId: string) {
  const opps = await db
    .select()
    .from(opportunities)
    .where(
      and(
        eq(opportunities.clientId, clientId),
        inArray(opportunities.status, ["approved", "executing", "completed", "deferred", "declined"]),
      ),
    )
    .orderBy(desc(opportunities.decidedAt));
  const batchIds = [...new Set(opps.map((o) => o.batchId).filter((x): x is string => !!x))];
  const [batchRows, execRows, jobRows] = batchIds.length
    ? await Promise.all([
        db.select().from(batches).where(inArray(batches.id, batchIds)),
        db
          .select()
          .from(executions)
          .where(and(inArray(executions.batchId, batchIds), ne(executions.status, "cancelled")))
          .orderBy(desc(executions.attempt)),
        db.select().from(githubJobs).where(inArray(githubJobs.batchId, batchIds)),
      ])
    : [[], [], []];
  // Latest attempt per opportunity.
  const execByOpp = new Map<string, (typeof execRows)[number]>();
  for (const e of execRows) if (!execByOpp.has(e.opportunityId)) execByOpp.set(e.opportunityId, e);
  return {
    opportunities: opps,
    batches: batchRows,
    executionByOpportunity: Object.fromEntries(execByOpp),
    jobs: jobRows,
  };
}

export async function getReportsOverview(clientId: string) {
  const [rolling] = await db
    .select()
    .from(metricSnapshots)
    .where(and(eq(metricSnapshots.clientId, clientId), eq(metricSnapshots.source, "siteguru"), eq(metricSnapshots.kind, "rolling30")))
    .orderBy(desc(metricSnapshots.capturedAt))
    .limit(1);
  const months = await db
    .select({ periodStart: metricSnapshots.periodStart, metrics: metricSnapshots.metrics })
    .from(metricSnapshots)
    .where(and(eq(metricSnapshots.clientId, clientId), eq(metricSnapshots.source, "siteguru"), eq(metricSnapshots.kind, "month")))
    .orderBy(desc(metricSnapshots.periodStart))
    .limit(24);
  const reports = await db
    .select({
      id: monthlyReports.id,
      period: monthlyReports.period,
      status: monthlyReports.status,
      generatedAt: monthlyReports.generatedAt,
      sentAt: monthlyReports.sentAt,
    })
    .from(monthlyReports)
    .where(eq(monthlyReports.clientId, clientId))
    .orderBy(desc(monthlyReports.period));
  return { rolling: (rolling?.metrics ?? null) as SiteMetrics | null, months, reports };
}

export async function getReport(clientId: string, reportId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(reportId)) return null;
  const [r] = await db
    .select()
    .from(monthlyReports)
    .where(and(eq(monthlyReports.id, reportId), eq(monthlyReports.clientId, clientId)));
  return r ?? null;
}

export async function getClientConnections(clientId: string) {
  return db.select().from(clientConnections).where(eq(clientConnections.clientId, clientId));
}

export async function getAttentionItems() {
  return db
    .select({ item: attentionItems, clientName: clients.name })
    .from(attentionItems)
    .leftJoin(clients, eq(clients.id, attentionItems.clientId))
    .where(eq(attentionItems.status, "open"))
    .orderBy(desc(attentionItems.createdAt));
}

export async function getAttentionSummary() {
  const rows = await db
    .select({ kind: attentionItems.kind, n: sql<number>`count(*)::int` })
    .from(attentionItems)
    .where(eq(attentionItems.status, "open"))
    .groupBy(attentionItems.kind);
  return rows;
}

export async function getIntegrations() {
  return db.select().from(integrations);
}

export async function getTierClientCounts() {
  const rows = await db
    .select({ tierId: clients.tierId, n: sql<number>`count(*)::int` })
    .from(clients)
    .where(isNull(clients.archivedAt))
    .groupBy(clients.tierId);
  return Object.fromEntries(rows.map((r) => [r.tierId, r.n]));
}

export const AUDIT_PAGE_SIZE = 50;

export async function getAuditLog(page: number, clientId: string | null) {
  const where = clientId ? eq(auditLog.clientId, clientId) : undefined;
  const rows = await db
    .select({ entry: auditLog, clientName: clients.name })
    .from(auditLog)
    .leftJoin(clients, eq(clients.id, auditLog.clientId))
    .where(where)
    .orderBy(desc(auditLog.at))
    .limit(AUDIT_PAGE_SIZE + 1)
    .offset(page * AUDIT_PAGE_SIZE);
  return { rows: rows.slice(0, AUDIT_PAGE_SIZE), hasMore: rows.length > AUDIT_PAGE_SIZE };
}

export async function getAllClientsBrief() {
  return db.select({ id: clients.id, name: clients.name }).from(clients).orderBy(asc(clients.name));
}
