import { notFound } from "next/navigation";
import { RecommendationsList } from "@/components/client/RecommendationsList";
import { getClient, getRecommendations } from "@/server/queries";

export default async function RecommendationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getClient(id);
  if (!data) notFound();
  const recs = await getRecommendations(id);
  return (
    <RecommendationsList
      clientId={id}
      clientStatus={data.client.status}
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
  );
}
