"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { planBlogNow } from "@/server/actions/clients";
import { generateReportNow } from "@/server/actions/reports";

const linkButton = "min-h-11 font-medium text-ink underline decoration-faint underline-offset-2 hover:decoration-ink disabled:text-subtle-2 md:min-h-0";

/** Shown when last month has no report yet (e.g. a client added mid-month). */
export function GenerateReportButton({ clientId, label }: { clientId: string; label: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      className={linkButton}
      onClick={async () => {
        setBusy(true);
        const r = await generateReportNow(clientId);
        setBusy(false);
        if (!r.ok) return toast({ message: r.error });
        router.push(`/clients/${clientId}/reports/${r.reportId}`);
      }}
    >
      {busy ? "Writing the report… (up to a minute)" : `Generate the ${label} report now`}
    </button>
  );
}

export function PlanBlogButton({ clientId }: { clientId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      className={linkButton}
      onClick={async () => {
        setBusy(true);
        const r = await planBlogNow(clientId);
        setBusy(false);
        toast({ message: r.ok ? "Planning this month’s posts — drafts follow within a few minutes" : r.error });
        if (r.ok) setTimeout(() => router.refresh(), 5000);
      }}
    >
      {busy ? "Starting…" : "Plan this month’s blog posts now"}
    </button>
  );
}
