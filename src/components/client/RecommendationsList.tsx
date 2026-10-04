"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { EvidenceItem } from "@/db/schema";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { cx } from "@/components/ui/cx";
import { EmptyState } from "@/components/ui/EmptyState";
import { PropertyRow } from "@/components/ui/PropertyRow";
import { Tag } from "@/components/ui/Tag";
import { CATEGORY_TAG, IMPACT_TAG } from "@/components/ui/tags";
import { useToast } from "@/components/ui/Toast";
import { formatDateTime } from "@/lib/format";
import { runScanNow } from "@/server/actions/clients";
import { DraftPreview } from "./DraftPreview";
import {
  approveRecommendations,
  cancelBatch,
  declineRecommendations,
  deferRecommendations,
  moveBack,
} from "@/server/actions/recommendations";

export type RecItem = {
  id: string;
  category: string;
  impact: string;
  title: string;
  description: string;
  targetUrl: string | null;
  why: string;
  evidence: EvidenceItem[];
  proposedAction: string;
  expectedBenefit: string;
  executionType: string;
  risk: string;
  draft: { title: string; body: string } | null;
};

export const SOURCE_LABEL: Record<string, string> = { siteguru: "SiteGuru", gbp: "GBP", serp: "SERP", crawl: "Site crawl" };
export const EXECUTION_LABEL: Record<string, string> = {
  github_pr: "Claude Code → GitHub PR",
  content_generation: "Claude Code → GitHub PR",
  gbp_api: "Google Business Profile API",
  manual_action: "Manual — you’ll get a checklist",
  outreach_draft: "Manual — you’ll get a checklist",
};

function startsInText(startsAtIso: string): string {
  const s = Math.max(0, Math.round((new Date(startsAtIso).getTime() - Date.now()) / 1000));
  if (s >= 90) return `${Math.round(s / 60)} min`;
  return `${s} sec`;
}

export function RecommendationsList({
  clientId,
  clientStatus,
  lastScan,
  items,
}: {
  clientId: string;
  clientStatus: string;
  lastScan: { status: string; at: string } | null;
  items: RecItem[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Optimistically hidden ids. Tied to the items they were hidden from: fresh server data resets them.
  const [hiddenState, setHiddenState] = useState<{ from: RecItem[]; ids: Set<string> }>({ from: items, ids: new Set() });
  const hidden = hiddenState.from === items ? hiddenState.ids : new Set<string>();
  const setHidden = (f: (h: Set<string>) => Set<string>) => setHiddenState({ from: items, ids: f(hidden) });
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<RecItem | null>(null);
  const approveKey = useRef<string | null>(null);

  const visible = items.filter((i) => !hidden.has(i.id));
  const selCount = visible.filter((i) => selected.has(i.id)).length;
  const allState = selCount === 0 ? "off" : selCount === visible.length ? "on" : "mixed";

  // Lift toasts above the mobile action bar while it is shown.
  useEffect(() => {
    const el = document.documentElement;
    el.style.setProperty("--action-bar-h", selCount > 0 && window.innerWidth < 768 ? "76px" : "0px");
    return () => el.style.setProperty("--action-bar-h", "0px");
  }, [selCount]);

  function toggle(id: string) {
    approveKey.current = null;
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function toggleAll() {
    approveKey.current = null;
    setSelected(allState === "on" ? new Set() : new Set(visible.map((i) => i.id)));
  }

  async function run(kind: "approve" | "defer" | "decline") {
    const ids = visible.filter((i) => selected.has(i.id)).map((i) => i.id);
    if (!ids.length || busy) return;
    setBusy(true);
    try {
      if (kind === "approve") {
        approveKey.current ??= crypto.randomUUID();
        const res = await approveRecommendations({ clientId, opportunityIds: ids, idempotencyKey: approveKey.current });
        if (!res.ok) return toast({ message: res.error });
        approveKey.current = null;
        setHidden((h) => new Set([...h, ...ids]));
        setSelected(new Set());
        toast({
          message: `${res.count} change${res.count === 1 ? "" : "s"} approved — starting in ${startsInText(res.startsAt)}`,
          durationMs: 8000,
          undo: async () => {
            const u = await cancelBatch(res.batchId);
            toast({ message: u.ok ? "Approval undone" : u.error });
            router.refresh();
          },
        });
      } else {
        const fn = kind === "defer" ? deferRecommendations : declineRecommendations;
        const res = await fn({ clientId, opportunityIds: ids });
        if (!res.ok) return toast({ message: res.error });
        setHidden((h) => new Set([...h, ...ids]));
        setSelected(new Set());
        toast({
          message: `${res.count} recommendation${res.count === 1 ? "" : "s"} ${kind === "defer" ? "deferred" : "declined"}`,
          undo: async () => {
            await moveBack({ clientId, opportunityIds: ids });
            router.refresh();
          },
        });
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (clientStatus === "awaiting_confirmation") {
    return <EmptyState>Waiting for you to confirm this client’s details.</EmptyState>;
  }
  if (clientStatus === "onboarding") {
    return <EmptyState>First site scan in progress — recommendations will appear here shortly.</EmptyState>;
  }

  const actionButtons = (mobile: boolean) => (
    <>
      <Button variant="danger" size={mobile ? "lg" : "md"} className={mobile ? "flex-1" : ""} disabled={!selCount || busy} onClick={() => run("decline")}>
        Decline
      </Button>
      <Button variant="secondary" size={mobile ? "lg" : "md"} className={mobile ? "flex-1" : ""} disabled={!selCount || busy} onClick={() => run("defer")}>
        Defer
      </Button>
      <Button size={mobile ? "lg" : "md"} className={mobile ? "flex-[1.4]" : ""} disabled={!selCount || busy} onClick={() => run("approve")}>
        Approve{selCount ? ` ${selCount}` : ""}
      </Button>
    </>
  );

  return (
    <div>
      {visible.length === 0 ? (
        <EmptyState>
          {lastScan?.status === "running" ? "Scanning the site — recommendations will appear here shortly." : "All caught up. New recommendations arrive after the next site scan."}
          <ScanNow clientId={clientId} lastScan={lastScan} />
        </EmptyState>
      ) : (
        <>
          <div className="sticky top-0 z-[2] flex min-h-12 items-center justify-between gap-2 border-y border-line bg-white px-1 py-2">
            <div className="flex items-center gap-2.5 font-medium text-ink-3">
              <Checkbox state={allState} onToggle={toggleAll} label="Select all" />
              <span>{selCount ? `${selCount} of ${visible.length} selected` : `${visible.length} outstanding`}</span>
            </div>
            <div className="hidden gap-1.5 md:flex [&_button:disabled]:opacity-40">{actionButtons(false)}</div>
          </div>

          {visible.map((r) => {
            const on = selected.has(r.id);
            const open = expanded.has(r.id);
            const cat = CATEGORY_TAG[r.category];
            const imp = IMPACT_TAG[r.impact];
            return (
              <div
                key={r.id}
                onClick={() => toggle(r.id)}
                className={cx("flex cursor-pointer gap-3.5 border-b border-line px-1 py-4 transition-quiet", on ? "bg-sidebar" : "hover:bg-row-hover")}
              >
                <Checkbox state={on ? "on" : "off"} onToggle={() => toggle(r.id)} label={`Select ${r.title}`} className="mt-[3px]" />
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 flex items-center gap-1.5">
                    {cat && <Tag color={cat.color}>{cat.label}</Tag>}
                    {imp && <Tag color={imp.color}>{imp.label}</Tag>}
                    <span className="flex-1" />
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpanded((s) => {
                          const n = new Set(s);
                          if (n.has(r.id)) n.delete(r.id);
                          else n.add(r.id);
                          return n;
                        });
                      }}
                      className="-my-3 -mr-1 flex min-h-11 items-center gap-1 px-1 text-[12px] text-subtle-2 hover:text-ink"
                    >
                      Details
                      <svg width="10" height="10" viewBox="0 0 10 10" className={cx("transition-transform duration-150", open && "rotate-180")} aria-hidden>
                        <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                  <div className="text-pretty text-[15px] font-semibold">{r.title}</div>
                  <div className="mt-[3px] text-muted">{r.description}</div>
                  {r.targetUrl && <div className="mt-1.5 break-all text-[12px] text-subtle-2">{r.targetUrl}</div>}
                  {open && (
                    <div className="mt-3 cursor-default border-t border-line" onClick={(e) => e.stopPropagation()}>
                      <RecDetails r={r} onPreview={() => setPreview(r)} />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <p className="mt-4 text-[12px] text-subtle-2">
            Approved changes start after a short undo window. Website changes arrive as one pull request per batch.
            {lastScan ? ` Last scan ${formatDateTime(lastScan.at)}.` : ""}
          </p>
        </>
      )}

      {/* Mobile fixed action bar */}
      {selCount > 0 && (
        <div className="pb-safe fixed inset-x-0 bottom-0 z-20 border-t border-line bg-white md:hidden">
          <div className="flex gap-2 px-4 py-2.5">{actionButtons(true)}</div>
        </div>
      )}

      {preview?.draft && <DraftPreview draft={preview.draft} onClose={() => setPreview(null)} />}
    </div>
  );
}

export function RecDetails({ r, onPreview }: { r: Pick<RecItem, "why" | "evidence" | "proposedAction" | "expectedBenefit" | "executionType" | "risk" | "draft">; onPreview?: () => void }) {
  return (
    <div className="text-[13px]">
      <PropertyRow label="Why" labelWidth={130}>
        <div className="py-1">{r.why || "—"}</div>
      </PropertyRow>
      <PropertyRow label="Evidence" labelWidth={130}>
        <ul className="py-1">
          {r.evidence.map((e, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-x-1.5">
              <span>
                {e.note ? `${e.note}: ` : ""}
                {e.metric} {String(e.value)}
                {e.period ? ` (${e.period})` : ""}
              </span>
              <span className="text-[12px] text-subtle-2">· {SOURCE_LABEL[e.source] ?? e.source}</span>
            </li>
          ))}
        </ul>
      </PropertyRow>
      <PropertyRow label="Proposed action" labelWidth={130}>
        <div className="py-1">{r.proposedAction || "—"}</div>
      </PropertyRow>
      <PropertyRow label="Expected benefit" labelWidth={130}>
        <div className="py-1">{r.expectedBenefit || "—"}</div>
      </PropertyRow>
      <PropertyRow label="Execution" labelWidth={130}>
        <div className="py-1">{EXECUTION_LABEL[r.executionType] ?? r.executionType}</div>
      </PropertyRow>
      <PropertyRow label="Risk" labelWidth={130} className={r.draft ? "" : "border-b-0"}>
        <div className="py-1 capitalize">{r.risk}</div>
      </PropertyRow>
      {r.draft && onPreview && (
        <button type="button" onClick={onPreview} className="mt-2 min-h-11 font-medium underline decoration-faint underline-offset-2 hover:decoration-ink md:min-h-0">
          Preview draft
        </button>
      )}
    </div>
  );
}

function ScanNow({ clientId, lastScan }: { clientId: string; lastScan: { status: string; at: string } | null }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (lastScan?.status === "running") return null;
  return (
    <div className="mt-3 text-[13px]">
      {lastScan && <div>Last scan {formatDateTime(lastScan.at)}{lastScan.status === "failed" ? " (failed)" : ""}</div>}
      <button
        type="button"
        disabled={busy}
        className="mt-1 min-h-11 font-medium text-ink underline decoration-faint underline-offset-2 hover:decoration-ink md:min-h-0"
        onClick={async () => {
          setBusy(true);
          const r = await runScanNow(clientId);
          setBusy(false);
          toast({ message: r.ok ? "Scan started — this takes a minute" : r.error });
          if (r.ok) setTimeout(() => router.refresh(), 4000);
        }}
      >
        {busy ? "Starting…" : "Run a scan now"}
      </button>
    </div>
  );
}
