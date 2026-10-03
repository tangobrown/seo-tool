import { notFound } from "next/navigation";
import { ClientTabs } from "@/components/client/ClientTabs";
import { AutoRefresh } from "@/components/ui/AutoRefresh";
import { Tag } from "@/components/ui/Tag";
import { TIER_TAG } from "@/components/ui/tags";
import { isBlogBehind, londonDayInfo } from "@/domain/blog";
import { SCAN_LABEL } from "@/lib/format";
import { getClient } from "@/server/queries";

export default async function ClientLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getClient(id);
  if (!data) notFound();
  const { client, tier, pending, commitment } = data;
  const committed = commitment?.committed ?? tier.postsPerMonth;
  const published = commitment?.published ?? 0;
  const behind = isBlogBehind({ committed, approved: commitment?.approved ?? 0, now: new Date(), ...londonDayInfo(new Date()) });

  return (
    <div>
      <h1 className="text-[26px] font-bold leading-[1.2] tracking-[-0.02em] md:text-[32px]">{client.name}</h1>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-muted">
        <span>{client.domain}</span>
        <Tag color={TIER_TAG[tier.name] ?? "gray"}>{tier.name}</Tag>
        <span className="text-[12px] text-subtle-2">
          {tier.postsPerMonth} posts / month · {SCAN_LABEL[tier.scanFrequency]} scans ·{" "}
          <span className={behind ? "text-tag-yellow-fg" : undefined}>
            Posts this month: {published} of {committed}
          </span>
        </span>
        {client.status === "archived" && <Tag color="gray">Archived</Tag>}
        {client.status === "paused" && <Tag color="yellow">Paused</Tag>}
      </div>
      {client.status === "onboarding" && <AutoRefresh />}
      <ClientTabs clientId={client.id} pending={pending} />
      {children}
    </div>
  );
}
