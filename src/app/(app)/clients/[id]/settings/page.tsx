import { notFound } from "next/navigation";
import { ClientSettings } from "@/components/client/ClientSettings";
import { getClient, getClientConnections, getTiers } from "@/server/queries";

export default async function ClientSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getClient(id);
  if (!data) notFound();
  const [tiers, connections] = await Promise.all([getTiers(), getClientConnections(id)]);
  const c = data.client;
  return (
    <ClientSettings
      key={c.status}
      client={{
        id: c.id,
        name: c.name,
        status: c.status,
        tierId: c.tierId,
        websiteUrl: c.websiteUrl,
        contactName: c.contactName,
        contactEmail: c.contactEmail,
        industry: c.industry,
        primaryLocation: c.primaryLocation,
        keywords: c.keywords,
        services: c.services,
        priorityServices: c.priorityServices,
        locations: c.locations,
        excludedServices: c.excludedServices,
        excludedLocations: c.excludedLocations,
        brandTone: c.brandTone,
        autoApproveLowImpact: c.autoApproveLowImpact,
        reviewBlogPosts: c.reviewBlogPosts,
        includeInMonthlyReport: c.includeInMonthlyReport,
        paused: c.paused,
        onboarding: c.onboarding,
        createdAt: c.createdAt.toISOString(),
      }}
      tiers={tiers.map((t) => ({ id: t.id, name: t.name, postsPerMonth: t.postsPerMonth, scanFrequency: t.scanFrequency, pricePence: t.pricePence }))}
      connections={connections.map((k) => ({
        provider: k.provider,
        status: k.status,
        externalId: k.externalId,
        lastSuccessAt: k.lastSuccessAt?.toISOString() ?? null,
        lastError: k.lastError,
      }))}
    />
  );
}
