import { ClientsDashboard } from "@/components/dashboard/ClientsDashboard";
import { getAttentionSummary, getDashboard } from "@/server/queries";

export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  const { archived } = await searchParams;
  const showArchived = archived === "1";
  const [data, attention] = await Promise.all([getDashboard(showArchived), getAttentionSummary()]);
  const pendingTotal = data.clients.reduce((n, c) => n + c.pending, 0);
  return (
    <ClientsDashboard
      showArchived={showArchived}
      archivedCount={data.archivedCount}
      pendingTotal={pendingTotal}
      attention={attention}
      clients={data.clients.map((c) => ({
        id: c.id,
        name: c.name,
        domain: c.domain,
        tier: c.tier,
        status: c.status,
        pending: c.pending,
        lastReport: c.lastReport ? new Date(c.lastReport).toISOString() : null,
        clicks: c.metrics?.clicks ?? null,
        prevClicks: c.metrics?.prev?.clicks ?? null,
      }))}
    />
  );
}
