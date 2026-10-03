"use client";

import { useSelectedLayoutSegment } from "next/navigation";
import { Tabs } from "@/components/ui/Tabs";

export function ClientTabs({ clientId, pending }: { clientId: string; pending: number }) {
  const seg = useSelectedLayoutSegment() ?? "recommendations";
  const base = `/clients/${clientId}`;
  return (
    <Tabs
      className="mb-5 mt-6"
      active={seg}
      items={[
        { key: "recommendations", label: "Recommendations", href: `${base}/recommendations`, count: pending, pill: true },
        { key: "actioned", label: "Actioned", href: `${base}/actioned` },
        { key: "reports", label: "Reports", href: `${base}/reports` },
        { key: "settings", label: "Settings", href: `${base}/settings` },
      ]}
    />
  );
}
