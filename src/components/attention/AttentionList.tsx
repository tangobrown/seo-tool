"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tag } from "@/components/ui/Tag";
import { ATTENTION_TAG } from "@/components/ui/tags";
import { useToast } from "@/components/ui/Toast";
import { markAttentionDone } from "@/server/actions/attention";

type Item = {
  id: string;
  kind: string;
  clientName: string | null;
  clientId: string | null;
  title: string;
  detail: string;
  link: string | null;
  checklist: string[] | null;
};

const ACTION_LABEL: Record<string, string> = {
  pr_review: "Open PR ↗",
  failed: "Details",
  integration: "Open integration",
  confirm_client: "Review",
  blog_commitment: "Open recommendations",
  report_ready: "Open report",
};

export function AttentionList({ items }: { items: Item[] }) {
  return (
    <div>
      <h1 className="mb-1.5 text-[28px] font-bold leading-tight tracking-[-0.02em] md:text-[36px]">Needs attention</h1>
      <p className="mb-7 text-muted">
        {items.length} item{items.length === 1 ? "" : "s"}
      </p>
      {items.length === 0 ? (
        <EmptyState>Nothing needs you right now.</EmptyState>
      ) : (
        <div className="border-t border-line">
          {items.map((i) => (
            <Row key={i.id} item={i} />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ item: i }: { item: Item }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const tag = ATTENTION_TAG[i.kind];
  const external = i.link?.startsWith("http");

  return (
    <div className="flex flex-col gap-2 border-b border-line px-1 py-4 md:flex-row md:items-start md:gap-4">
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          {tag && <Tag color={tag.color}>{tag.label}</Tag>}
          {i.clientName && <span className="text-[13px] text-muted">{i.clientName}</span>}
        </div>
        <div className="text-pretty text-[15px] font-semibold">{i.title}</div>
        {i.detail && <div className="mt-[3px] text-muted">{i.detail}</div>}
        {i.checklist && (
          <ol className="mt-2 list-decimal pl-5 text-[13px] text-ink-3">
            {i.checklist.map((c, idx) => (
              <li key={idx}>{c}</li>
            ))}
          </ol>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {i.kind === "failed" && i.link && (
          <Link href={i.link} className="min-h-11 content-center text-[13px] font-medium hover:underline md:min-h-0">
            Retry
          </Link>
        )}
        {i.kind === "manual_action" ? (
          <Button
            variant="neutral"
            disabled={pending}
            className="min-h-11 md:min-h-0"
            onClick={() =>
              start(async () => {
                const r = await markAttentionDone(i.id);
                toast({ message: r.ok ? "Marked done" : r.error });
                router.refresh();
              })
            }
          >
            Mark done
          </Button>
        ) : i.link ? (
          external ? (
            <a href={i.link} target="_blank" rel="noreferrer" className="min-h-11 content-center text-[13px] font-medium hover:underline md:min-h-0">
              {ACTION_LABEL[i.kind] ?? "Open"}
            </a>
          ) : (
            <Link href={i.link} className="min-h-11 content-center text-[13px] font-medium hover:underline md:min-h-0">
              {ACTION_LABEL[i.kind] ?? "Open"}
            </Link>
          )
        ) : null}
      </div>
    </div>
  );
}
