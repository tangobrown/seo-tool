"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { ReportSection } from "@/db/schema";
import { Button } from "@/components/ui/Button";
import { Tag } from "@/components/ui/Tag";
import { useToast } from "@/components/ui/Toast";
import { firstName } from "@/domain/report-email";
import { formatDayMonth } from "@/lib/format";
import { markReportRead, markReportSent } from "@/server/actions/reports";

type Props = {
  backHref: string;
  report: {
    id: string;
    label: string;
    status: string;
    sentAt: string | null;
    clientName: string;
    contactName: string;
    sendTo: string;
    period: string;
    generated: string;
    summary: string;
    sections: ReportSection[];
    signoff: string;
    emailText: string;
    emailHtml: string;
    subject: string;
  };
};

async function copyRich(text: string, html: string): Promise<void> {
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return;
    }
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback: hidden textarea + execCommand.
    const t = document.createElement("textarea");
    t.value = text;
    t.style.position = "fixed";
    t.style.opacity = "0";
    document.body.appendChild(t);
    t.select();
    try {
      document.execCommand("copy");
    } finally {
      t.remove();
    }
  }
}

export function ReportDocument({ backHref, report: r }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const [sentAt, setSentAt] = useState(r.sentAt);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (r.status === "generated") void markReportRead(r.id);
  }, [r.id, r.status]);

  return (
    <div className="max-w-[680px]">
      <Link href={backHref} className="-ml-1.5 mb-4 inline-flex min-h-11 items-center rounded px-1.5 py-0.5 text-muted transition-quiet hover:bg-hover md:min-h-0">
        ← All reports
      </Link>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.01em] md:text-[32px]">{r.label} report</h1>
        <div className="flex shrink-0 items-center gap-2">
          {sentAt ? (
            <Tag color="green">Sent {formatDayMonth(sentAt)}</Tag>
          ) : (
            <Button
              variant="secondary"
              className="min-h-11 md:min-h-0"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const res = await markReportSent(r.id);
                  if (res.ok) {
                    setSentAt(res.sentAt);
                    toast({ message: "Marked as sent" });
                    router.refresh();
                  } else toast({ message: res.error });
                })
              }
            >
              Mark as sent
            </Button>
          )}
          <Button
            className="min-h-11 md:min-h-0"
            onClick={async () => {
              await copyRich(r.emailText, r.emailHtml);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
              toast({ message: "Report copied — paste it into an email" });
            }}
          >
            {copied ? "Copied" : "Copy for email"}
          </Button>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-[100px_1fr] gap-y-1 text-[13px] md:grid-cols-[120px_1fr]">
        <div className="text-subtle-2">Client</div>
        <div>{r.clientName}</div>
        <div className="text-subtle-2">Period</div>
        <div>{r.period}</div>
        <div className="text-subtle-2">Generated</div>
        <div>{r.generated}</div>
        <div className="text-subtle-2">Send to</div>
        <div className="break-all">{r.sendTo || "—"}</div>
        <div className="text-subtle-2">Subject</div>
        <div>{r.subject}</div>
      </div>

      <div className="mt-6 border-t border-line pt-5 text-[16px] leading-[1.6] md:text-[17px]">
        <p className="mb-4">Hi {firstName(r.contactName)},</p>
        <p className="mb-4">{r.summary}</p>
        {r.sections.map((s) => (
          <div key={s.title} className="mb-4">
            <h3 className="mb-1 text-[15px] font-semibold">{s.title}</h3>
            <ul className="list-disc pl-5">
              {s.items.map((i, idx) => (
                <li key={idx}>{i}</li>
              ))}
            </ul>
          </div>
        ))}
        <p className="mt-6 whitespace-pre-line">{r.signoff}</p>
      </div>
    </div>
  );
}
