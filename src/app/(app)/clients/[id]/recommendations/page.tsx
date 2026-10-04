import { notFound } from "next/navigation";
import { RecommendationsList } from "@/components/client/RecommendationsList";
import { AutoRefresh } from "@/components/ui/AutoRefresh";
import { getClient, getLastScan, getRecommendations } from "@/server/queries";

export default async function RecommendationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getClient(id);
  if (!data) notFound();
  const [recs, lastScan] = await Promise.all([getRecommendations(id), getLastScan(id)]);
  return (
    <>
    {lastScan?.status === "running" && <AutoRefresh everyMs={5000} />}
    <RecommendationsList
      clientId={id}
      clientStatus={data.client.status}
      lastScan={lastScan ? { status: lastScan.status, at: (lastScan.finishedAt ?? lastScan.startedAt).toISOString() } : null}
      items={recs.map((r) => ({
        id: r.id,
        category: r.category,
        impact: r.impactLabel,
        title: r.title,
        description: r.description,
        targetUrl: r.targetUrl,
        why: r.why,
        evidence: r.evidence,
        proposedAction: r.proposedAction,
        expectedBenefit: r.expectedBenefit,
        executionType: r.executionType,
        risk: r.riskLabel,
        draft: (r.payload?.draft as { title: string; body: string } | undefined) ?? null,
      }))}
    />
    </>
  );
}
