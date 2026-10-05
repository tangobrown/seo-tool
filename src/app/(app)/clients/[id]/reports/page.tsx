import Link from "next/link";
import { notFound } from "next/navigation";
import { BarChart, type Bar } from "@/components/ui/BarChart";
import { GenerateReportButton } from "@/components/client/ReportActions";
import { EmptyState } from "@/components/ui/EmptyState";
import { KpiStrip, type Kpi } from "@/components/ui/KpiStrip";
import { Tag } from "@/components/ui/Tag";
import { formatDate, formatDayMonth, formatMonthShort, formatMonthYear, formatNumber, periodOf } from "@/lib/format";
import { previousPeriod } from "@/domain/schedule";
import { getClient, getReportsOverview } from "@/server/queries";

function delta(curr: number | null | undefined, prev: number | null | undefined, lowerIsBetter = false): Kpi["delta"] {
  if (curr == null || prev == null || prev === 0) return null;
  const d = ((curr - prev) / prev) * 100;
  const good = lowerIsBetter ? d <= 0 : d >= 0;
  return { text: `${d >= 0 ? "↑" : "↓"} ${Math.abs(d).toFixed(1)}%`, good };
}

function nextFirst(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export default async function ReportsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getClient(id);
  if (!data) notFound();
  const { rolling, months, reports } = await getReportsOverview(id);
  const base = `/clients/${id}/reports`;
  const lastPeriod = previousPeriod(periodOf(new Date()));
  const canGenerate = data.client.status === "active" && data.client.includeInMonthlyReport && !reports.some((r) => r.period === lastPeriod);

  if (!rolling && !reports.length) {
    return (
      <EmptyState>
        Connecting to SiteGuru. Data will appear within 24 hours — the first monthly report generates on {formatDate(nextFirst(new Date()))}.
      </EmptyState>
    );
  }

  const latest = reports[0];
  const showBanner = latest && latest.status === "generated";

  const kpis: Kpi[] = [
    { label: "Organic clicks", value: formatNumber(rolling?.clicks), delta: delta(rolling?.clicks, rolling?.prev?.clicks) },
    { label: "Impressions", value: formatNumber(rolling?.impressions), delta: delta(rolling?.impressions, rolling?.prev?.impressions) },
    {
      label: "Avg. position",
      value: rolling?.avgPosition != null ? rolling.avgPosition.toFixed(1) : "—",
      delta: delta(rolling?.avgPosition, rolling?.prev?.avgPosition, true),
    },
    { label: "Click-through rate", value: rolling?.ctr != null ? `${rolling.ctr.toFixed(1)}%` : "—", delta: delta(rolling?.ctr, rolling?.prev?.ctr) },
  ];

  // 12 bars ending with the current month. Months without a snapshot are grey placeholders.
  const now = new Date();
  const byPeriod = new Map(months.map((m) => [periodOf(m.periodStart), m.metrics.clicks ?? null]));
  const bars: Bar[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1 - i, 15));
    const p = periodOf(d);
    const v = byPeriod.get(p) ?? null;
    bars.push({ label: formatMonthShort(p), value: v, current: i === 0, title: v != null ? `${formatMonthShort(p)}: ${formatNumber(v)} clicks` : undefined });
  }

  return (
    <div>
      {showBanner && (
        <Link href={`${base}/${latest.id}`} className="mb-7 flex items-center justify-between gap-3 rounded-lg bg-sidebar px-3.5 py-3 transition-quiet hover:bg-banner-hover">
          <span>
            <strong className="font-semibold">{formatMonthYear(latest.period)} report is ready.</strong>{" "}
            <span className="text-muted">Generated {formatDayMonth(latest.generatedAt)} — review it and copy into an email.</span>
          </span>
          <span className="shrink-0 font-medium">Open →</span>
        </Link>
      )}

      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[16px] font-semibold">Last 30 days</h2>
        <span className="text-[12px] text-subtle-2">vs previous 30 days</span>
      </div>
      <KpiStrip items={kpis} />

      <h2 className="mb-3 mt-9 text-[16px] font-semibold">Organic clicks by month</h2>
      <BarChart bars={bars} />

      <div className="mt-9 grid gap-8 md:grid-cols-[repeat(auto-fit,minmax(280px,1fr))]">
        <div>
          <h2 className="mb-2 text-[16px] font-semibold">Top pages</h2>
          {(rolling?.topPages ?? []).length === 0 && <div className="py-2 text-subtle-2">—</div>}
          {(rolling?.topPages ?? []).map((p) => (
            <div key={p.path} className="flex justify-between gap-3 border-b border-line py-[7px]">
              <span className="truncate">{p.path}</span>
              <span className="text-muted">{formatNumber(p.clicks)}</span>
            </div>
          ))}
        </div>
        <div>
          <h2 className="mb-2 text-[16px] font-semibold">Top keywords</h2>
          {(rolling?.topKeywords ?? []).length === 0 && <div className="py-2 text-subtle-2">—</div>}
          {(rolling?.topKeywords ?? []).map((k) => (
            <div key={k.keyword} className="flex items-center gap-3 border-b border-line py-[7px]">
              <span className="min-w-0 flex-1 truncate">{k.keyword}</span>
              <span className="text-muted">#{k.position}</span>
              <span className={`w-8 text-right text-[12px] ${k.change == null || k.change === 0 ? "text-subtle-2" : k.change > 0 ? "text-positive" : "text-negative"}`}>
                {k.change == null || k.change === 0 ? "–" : `${k.change > 0 ? "↑" : "↓"}${Math.abs(k.change)}`}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-10">
        <h2 className="mb-1.5 text-[16px] font-semibold">Monthly reports</h2>
        <p className="mb-3 text-[13px] text-muted">A summary of the previous month is generated on the 1st of each month.</p>
        {reports.length === 0 && !canGenerate && <div className="py-3 text-subtle-2">The first report generates on {formatDate(nextFirst(now))}.</div>}
        {canGenerate && (
          <div className="mb-2 text-[13px]">
            <GenerateReportButton clientId={id} label={formatMonthYear(lastPeriod)} />
          </div>
        )}
        {reports.map((r) => (
          <Link key={r.id} href={`${base}/${r.id}`} className="flex min-h-12 items-center gap-3 border-b border-line px-1 py-2.5 transition-quiet hover:bg-row-hover">
            <span aria-hidden className="h-6 w-5 shrink-0 rounded-[3px] border-[1.5px] border-faint" />
            <span className="font-medium">{formatMonthYear(r.period)}</span>
            {r.status === "generated" && <Tag color="blue">New</Tag>}
            {r.status === "sent" && r.sentAt && <Tag color="green">Sent {formatDayMonth(r.sentAt)}</Tag>}
            <span className="flex-1" />
            <span className="text-[13px] text-subtle-2">Generated {formatDayMonth(r.generatedAt)}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
