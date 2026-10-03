import { notFound } from "next/navigation";
import { ReportDocument } from "@/components/client/ReportDocument";
import { formatDate, formatMonthYear } from "@/lib/format";
import { reportSubject } from "@/domain/report-email";
import { getClient, getReport, getWorkspace } from "@/server/queries";

export default async function ReportPage({ params }: { params: Promise<{ id: string; reportId: string }> }) {
  const { id, reportId } = await params;
  const [data, report, ws] = await Promise.all([getClient(id), getReport(id, reportId), getWorkspace()]);
  if (!data || !report) notFound();
  const [y, m] = report.period.split("-").map(Number);
  const start = new Date(Date.UTC(y!, m! - 1, 1));
  const end = new Date(Date.UTC(y!, m!, 0));
  const label = formatMonthYear(report.period);
  return (
    <ReportDocument
      backHref={`/clients/${id}/reports`}
      report={{
        id: report.id,
        label,
        status: report.status,
        sentAt: report.sentAt?.toISOString() ?? null,
        clientName: data.client.name,
        contactName: data.client.contactName,
        sendTo: data.client.contactEmail,
        period: `${start.getUTCDate()}–${end.getUTCDate()} ${label}`,
        generated: formatDate(report.generatedAt),
        summary: report.summary,
        sections: report.sections,
        signoff: ws.signoff,
        emailText: report.emailText,
        emailHtml: report.emailHtml,
        subject: reportSubject(label, data.client.name),
      }}
    />
  );
}
