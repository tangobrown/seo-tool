"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatDateTime } from "@/lib/format";

type Row = { id: string; at: string; actor: string; clientName: string | null; event: string; before: unknown; after: unknown; meta: unknown };

const ACTOR: Record<string, string> = { operator: "You", system: "System", claude_code: "Claude Code", webhook: "Webhook" };

function humanEvent(e: string) {
  return e.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function ActivityLog({
  rows,
  page,
  hasMore,
  clientId,
  clients,
}: {
  rows: Row[];
  page: number;
  hasMore: boolean;
  clientId: string | null;
  clients: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const qs = (p: number) => `/settings/activity?page=${p}${clientId ? `&client=${clientId}` : ""}`;
  return (
    <div>
      <select
        aria-label="Filter by client"
        className="mb-3 min-h-11 rounded-md border border-control bg-white px-2.5 md:min-h-0 md:py-1.5"
        value={clientId ?? ""}
        onChange={(e) => router.push(`/settings/activity${e.target.value ? `?client=${e.target.value}` : ""}`)}
      >
        <option value="">All clients</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {rows.length === 0 && <div className="py-12 text-center text-subtle-2">No activity yet.</div>}
      {rows.map((r) => (
        <div key={r.id} className="border-b border-line">
          <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)} className="flex w-full flex-col gap-0.5 py-2.5 text-left md:flex-row md:items-baseline md:gap-3">
            <span className="w-28 shrink-0 text-[12px] text-subtle-2">{formatDateTime(r.at)}</span>
            <span className="min-w-0 flex-1">
              {humanEvent(r.event)}
              {r.clientName && <span className="text-muted"> · {r.clientName}</span>}
            </span>
            <span className="text-[12px] text-subtle-2">{ACTOR[r.actor] ?? r.actor}</span>
          </button>
          {open === r.id && (
            <div className="mb-3 grid gap-2 text-[12px] md:grid-cols-2">
              <div>
                <div className="mb-1 text-subtle-2">Before</div>
                <pre className="whitespace-pre-wrap break-all rounded bg-sidebar p-2">{JSON.stringify(r.before, null, 2) ?? "—"}</pre>
              </div>
              <div>
                <div className="mb-1 text-subtle-2">After</div>
                <pre className="whitespace-pre-wrap break-all rounded bg-sidebar p-2">{JSON.stringify(r.after ?? r.meta, null, 2) ?? "—"}</pre>
              </div>
            </div>
          )}
        </div>
      ))}
      <div className="mt-4 flex justify-between text-[13px]">
        {page > 0 ? <Link href={qs(page - 1)} className="min-h-11 content-center hover:underline">← Newer</Link> : <span />}
        {hasMore && <Link href={qs(page + 1)} className="min-h-11 content-center hover:underline">Older →</Link>}
      </div>
    </div>
  );
}
