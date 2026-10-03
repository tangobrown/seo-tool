"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { cx } from "@/components/ui/cx";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tag } from "@/components/ui/Tag";
import { CATEGORY_TAG, DECISION_TAG, EXECUTION_TAG, IMPACT_TAG } from "@/components/ui/tags";
import { useToast } from "@/components/ui/Toast";
import { formatDateTime, formatDayMonth } from "@/lib/format";
import { cancelBatch, moveBack, retryExecution } from "@/server/actions/recommendations";

export type ActionedItem = {
  id: string;
  category: string;
  impact: string;
  title: string;
  description: string;
  targetUrl: string | null;
  decision: "approved" | "deferred" | "declined";
  decidedAt: string | null;
  decidedBy: string | null;
  deferredUntil: string | null;
  statusNote: string | null;
  execution: { id: string; status: string; error: string | null; prUrl: string | null } | null;
  batch: { id: string; status: string; startsAt: string; createdAt: string; createdBy: string; prNumber: number | null } | null;
};

type Filter = "all" | "approved" | "deferred" | "declined";
// PR ready is included: a merge (webhook) moves it on while the page is open.
const TRANSIENT = new Set(["queued", "running", "pr_ready", "merged"]);

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function countdown(startsAt: string, now: number) {
  const s = Math.max(0, Math.ceil((new Date(startsAt).getTime() - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function ActionedList({ clientId, items }: { clientId: string; items: ActionedItem[] }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const now = useNow(1000);

  // Keep execution statuses fresh while anything is in flight.
  const inFlight = items.some((i) => i.execution && TRANSIENT.has(i.execution.status));
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(t);
  }, [inFlight, router]);

  const counts = {
    all: items.length,
    approved: items.filter((i) => i.decision === "approved").length,
    deferred: items.filter((i) => i.decision === "deferred").length,
    declined: items.filter((i) => i.decision === "declined").length,
  };
  const shown = filter === "all" ? items : items.filter((i) => i.decision === filter);

  // Group approved items by batch; others stand alone. Newest first.
  type Section = { key: string; at: number; batch: ActionedItem["batch"]; items: ActionedItem[] };
  const sections: Section[] = [];
  const byBatch = new Map<string, Section>();
  for (const i of shown) {
    if (i.decision === "approved" && i.batch) {
      let s = byBatch.get(i.batch.id);
      if (!s) {
        s = { key: i.batch.id, at: new Date(i.batch.createdAt).getTime(), batch: i.batch, items: [] };
        byBatch.set(i.batch.id, s);
        sections.push(s);
      }
      s.items.push(i);
    } else {
      sections.push({ key: i.id, at: i.decidedAt ? new Date(i.decidedAt).getTime() : 0, batch: null, items: [i] });
    }
  }
  sections.sort((a, b) => b.at - a.at);

  return (
    <div>
      <div className="no-scrollbar -mx-4 mb-3 flex gap-1.5 overflow-x-auto px-4 md:mx-0 md:px-0">
        {(["all", "approved", "deferred", "declined"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cx(
              "min-h-9 shrink-0 rounded-[14px] border px-2.5 py-[3px] text-[13px] capitalize transition-quiet md:min-h-0",
              filter === f ? "border-ink bg-ink text-white" : "border-control bg-white text-ink-3 hover:bg-hover",
            )}
          >
            {f} <span className="opacity-60">{counts[f]}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 && <EmptyState>Nothing here yet.</EmptyState>}

      {sections.map((s) => (
        <div key={s.key}>
          {s.batch && <BatchHeading batch={s.batch} count={s.items.length} now={now} clientId={clientId} />}
          {s.items.map((i) => (
            <ActionedRow key={i.id} item={i} clientId={clientId} now={now} />
          ))}
        </div>
      ))}
    </div>
  );
}

function BatchHeading({ batch, count, now, clientId }: { batch: NonNullable<ActionedItem["batch"]>; count: number; now: number; clientId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const queued = batch.status === "pending_start";
  void clientId;
  return (
    <div className="flex items-center justify-between gap-2 pb-1 pt-5 text-[12px] text-subtle-2">
      <span>
        {batch.createdBy === "auto" ? "Auto batch" : "Batch"} · {formatDateTime(batch.createdAt)} · {count} change{count === 1 ? "" : "s"}
        {batch.prNumber ? ` · PR #${batch.prNumber}` : ""}
        {queued ? ` · starts in ${countdown(batch.startsAt, now)}` : ""}
      </span>
      {queued && (
        <button
          type="button"
          disabled={pending}
          className="-my-3 min-h-11 px-1 text-[13px] text-negative hover:underline md:min-h-0"
          onClick={() =>
            start(async () => {
              const r = await cancelBatch(batch.id);
              toast({ message: r.ok ? "Batch cancelled — changes moved back to Recommendations" : r.error });
              router.refresh();
            })
          }
        >
          Cancel batch
        </button>
      )}
    </div>
  );
}

function whoWhen(i: ActionedItem): string {
  if (i.decision === "deferred") return i.deferredUntil ? `Deferred until ${formatDayMonth(i.deferredUntil)}` : "Deferred";
  if (i.decision === "declined") return i.decidedAt ? `Declined ${formatDateTime(i.decidedAt)}` : "Declined";
  if (i.batch?.createdBy === "auto" || i.decidedBy === "system") return "Auto-approved";
  return i.decidedAt ? `Approved ${formatDateTime(i.decidedAt)}` : "Approved";
}

function ActionedRow({ item: i, clientId, now }: { item: ActionedItem; clientId: string; now: number }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const cat = CATEGORY_TAG[i.category];
  const imp = IMPACT_TAG[i.impact];
  const exec = i.execution;
  const queued = i.decision === "approved" && i.batch?.status === "pending_start";
  const canMoveBack = i.decision !== "approved" || queued;

  const doMoveBack = () =>
    start(async () => {
      const r = await moveBack({ clientId, opportunityIds: [i.id] });
      toast({ message: r.ok ? "Moved back to Recommendations" : r.error });
      router.refresh();
    });

  const statusTag =
    i.decision === "approved" && exec ? (
      <Tag color={EXECUTION_TAG[exec.status]?.color}>{EXECUTION_TAG[exec.status]?.label ?? exec.status}</Tag>
    ) : (
      <Tag color={DECISION_TAG[i.decision]?.color}>{DECISION_TAG[i.decision]?.label}</Tag>
    );

  return (
    <div className="flex flex-col gap-2 border-b border-line px-1 py-4 md:flex-row md:gap-4">
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          {cat && <Tag color={cat.color}>{cat.label}</Tag>}
          {imp && <Tag color={imp.color}>{imp.label}</Tag>}
        </div>
        <div className="text-pretty text-[15px] font-semibold">{i.title}</div>
        <div className="mt-[3px] text-muted">{i.description}</div>
        {i.targetUrl && <div className="mt-1.5 break-all text-[12px] text-subtle-2">{i.targetUrl}</div>}
        <div className="mt-1.5 text-[12px] text-subtle-2">
          {whoWhen(i)}
          {i.statusNote ? ` · ${i.statusNote}` : ""}
        </div>
        {exec?.status === "failed" && exec.error && <div className="mt-1.5 text-[13px] text-negative">{exec.error}</div>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 md:flex-col md:items-end md:gap-1.5">
        {statusTag}
        {queued && i.batch && <span className="text-[12px] text-subtle-2">Starts in {countdown(i.batch.startsAt, now)}</span>}
        {exec?.status === "pr_ready" && exec.prUrl && (
          <a href={exec.prUrl} target="_blank" rel="noreferrer" className="text-[13px] font-medium hover:underline">
            Open PR ↗
          </a>
        )}
        {exec?.status === "failed" && (
          <button
            type="button"
            disabled={pending}
            className="min-h-11 text-[13px] font-medium hover:underline md:min-h-0"
            onClick={() =>
              start(async () => {
                const r = await retryExecution(exec.id);
                toast({ message: r.ok ? "Retrying — a fresh attempt has started" : r.error });
                router.refresh();
              })
            }
          >
            Retry
          </button>
        )}
        {exec?.status === "action_needed" && (
          <Link href="/attention" className="text-[13px] font-medium hover:underline">
            Open checklist
          </Link>
        )}
        {canMoveBack && (
          <button type="button" disabled={pending} onClick={doMoveBack} className="min-h-11 text-[13px] text-subtle-2 transition-quiet hover:text-ink md:min-h-0">
            Move back
          </button>
        )}
      </div>
    </div>
  );
}
