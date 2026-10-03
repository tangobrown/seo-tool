"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Tag } from "@/components/ui/Tag";
import { TIER_TAG } from "@/components/ui/tags";
import { useToast } from "@/components/ui/Toast";
import { formatDate, formatNumber, pctChange } from "@/lib/format";
import { restoreClient } from "@/server/actions/clients";

type Row = {
  id: string;
  name: string;
  domain: string;
  tier: string;
  status: string;
  pending: number;
  lastReport: string | null;
  clicks: number | null;
  prevClicks: number | null;
};

const KIND_PHRASE: Record<string, [string, string]> = {
  failed: ["failed job", "failed jobs"],
  pr_review: ["PR to review", "PRs to review"],
  manual_action: ["manual action", "manual actions"],
  integration: ["integration issue", "integration issues"],
  confirm_client: ["client to confirm", "clients to confirm"],
  blog_commitment: ["blog commitment behind", "blog commitments behind"],
  report_ready: ["report to send", "reports to send"],
};

export function ClientsDashboard({
  clients,
  pendingTotal,
  attention,
  showArchived,
  archivedCount,
}: {
  clients: Row[];
  pendingTotal: number;
  attention: { kind: string; n: number }[];
  showArchived: boolean;
  archivedCount: number;
}) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const rows = query ? clients.filter((c) => c.name.toLowerCase().includes(query) || c.domain.includes(query)) : clients;
  const attnTotal = attention.reduce((n, a) => n + a.n, 0);

  return (
    <div>
      <h1 className="mb-1.5 text-[28px] font-bold leading-tight tracking-[-0.02em] md:text-[36px]">{showArchived ? "Archived clients" : "Clients"}</h1>
      <p className="mb-7 text-muted">
        {showArchived
          ? `${clients.length} archived`
          : `${clients.length} client${clients.length === 1 ? "" : "s"} · ${pendingTotal} recommendation${pendingTotal === 1 ? "" : "s"} awaiting review`}
      </p>

      {!showArchived && attnTotal > 0 && (
        <Link href="/attention" className="mb-7 flex items-center justify-between gap-3 rounded-lg bg-sidebar px-3.5 py-3 transition-quiet hover:bg-banner-hover">
          <span>
            <strong className="font-semibold">
              {attnTotal} thing{attnTotal === 1 ? "" : "s"} need{attnTotal === 1 ? "s" : ""} your attention.
            </strong>{" "}
            <span className="text-muted">
              {attention.map((a) => `${a.n} ${KIND_PHRASE[a.kind]?.[a.n === 1 ? 0 : 1] ?? a.kind}`).join(" · ")}
            </span>
          </span>
          <span className="shrink-0 font-medium">Open →</span>
        </Link>
      )}

      <div className="flex items-center gap-3 border-b border-line pb-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search clients…"
          className="min-h-11 min-w-0 flex-1 bg-transparent outline-none placeholder:text-subtle-2 md:min-h-0"
          type="search"
        />
        {!showArchived && (
          <Button onClick={() => window.dispatchEvent(new Event("open-new-client"))} className="min-h-11 md:min-h-0">
            New client
          </Button>
        )}
      </div>

      {/* Desktop header */}
      <div className="hidden grid-cols-[2.4fr_0.9fr_1.1fr_1fr_1.2fr] gap-3 border-b border-line px-1.5 py-2 text-[12px] text-subtle-2 md:grid">
        <div>Client</div>
        <div>Tier</div>
        <div>Pending</div>
        <div>Last report</div>
        <div>Organic clicks (30d)</div>
      </div>

      {rows.length === 0 && (
        <div className="py-12 text-center text-subtle-2">
          {query ? `No clients match “${q.trim()}”.` : showArchived ? "No archived clients." : "No clients yet. Add your first one."}
        </div>
      )}

      {rows.map((c) => (showArchived ? <ArchivedRow key={c.id} c={c} /> : <ClientRow key={c.id} c={c} />))}

      <div className="mt-6 text-[13px]">
        {showArchived ? (
          <Link href="/" className="text-subtle-2 hover:text-ink">
            ← Back to clients
          </Link>
        ) : archivedCount > 0 ? (
          <Link href="/?archived=1" className="text-subtle-2 hover:text-ink">
            Show archived ({archivedCount})
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function PendingCell({ c }: { c: Row }) {
  if (c.status === "onboarding") return <span className="text-subtle-2">Scanning site…</span>;
  if (c.status === "awaiting_confirmation")
    return (
      <span className="inline-flex items-center gap-1.5 font-medium text-tag-yellow-fg">
        <span className="size-1.5 rounded-full bg-tag-yellow-fg" />
        Confirm details
      </span>
    );
  if (c.status === "paused") return <span className="text-subtle-2">Paused</span>;
  if (c.pending > 0)
    return (
      <span className="inline-flex items-center gap-1.5 font-medium">
        <span className="size-1.5 rounded-full bg-alert" />
        {c.pending} pending
      </span>
    );
  return <span className="text-subtle-2">All reviewed</span>;
}

function Clicks({ c }: { c: Row }) {
  if (c.clicks == null) return <span className="text-subtle-2">—</span>;
  const d = pctChange(c.clicks, c.prevClicks);
  return (
    <span className="whitespace-nowrap">
      {formatNumber(c.clicks)}
      {d !== null && (
        <span className={`ml-1.5 text-[12px] ${d >= 0 ? "text-positive" : "text-negative"}`}>
          {d >= 0 ? "↑" : "↓"} {Math.abs(d)}%
        </span>
      )}
    </span>
  );
}

function ClientRow({ c }: { c: Row }) {
  const href = c.status === "awaiting_confirmation" ? `/clients/${c.id}/settings` : `/clients/${c.id}/recommendations`;
  return (
    <Link href={href} className="block border-b border-line px-1.5 py-3 transition-quiet hover:bg-sidebar">
      {/* Mobile: two lines */}
      <div className="md:hidden">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-medium">{c.name}</span>
          <Tag color={TIER_TAG[c.tier] ?? "gray"}>{c.tier}</Tag>
        </div>
        <div className="mt-1 flex items-center justify-between gap-2 text-[13px]">
          <PendingCell c={c} />
          <Clicks c={c} />
        </div>
      </div>
      {/* Desktop: grid */}
      <div className="hidden grid-cols-[2.4fr_0.9fr_1.1fr_1fr_1.2fr] items-center gap-3 md:grid">
        <div className="truncate font-medium">{c.name}</div>
        <div>
          <Tag color={TIER_TAG[c.tier] ?? "gray"}>{c.tier}</Tag>
        </div>
        <div>
          <PendingCell c={c} />
        </div>
        <div className="text-muted">{formatDate(c.lastReport)}</div>
        <div>
          <Clicks c={c} />
        </div>
      </div>
    </Link>
  );
}

function ArchivedRow({ c }: { c: Row }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line px-1.5 py-3">
      <div className="min-w-0">
        <div className="truncate font-medium">{c.name}</div>
        <div className="text-[13px] text-subtle-2">{c.domain}</div>
      </div>
      <Button
        variant="secondary"
        disabled={pending}
        className="min-h-11 md:min-h-0"
        onClick={() =>
          start(async () => {
            const r = await restoreClient(c.id);
            if (r.ok) {
              toast({ message: `${c.name} restored` });
              router.refresh();
            } else toast({ message: r.error });
          })
        }
      >
        Restore
      </Button>
    </div>
  );
}
