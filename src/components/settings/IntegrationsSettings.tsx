"use client";

import Link from "next/link";
import { useState } from "react";
import { cx } from "@/components/ui/cx";
import { formatDateTime } from "@/lib/format";

type Row = { provider: string; status: string; lastSuccessAt: string | null; lastFailureAt: string | null; lastError: string | null; account: string | null };

const PROVIDERS = [
  { key: "siteguru", name: "SiteGuru", letter: "SG", desc: "SEO data: technical issues, rankings, traffic" },
  { key: "github", name: "GitHub", letter: "GH", desc: "GitHub App: client repos, setup PRs and Claude Code runs" },
  { key: "gbp", name: "Google Business Profile", letter: "G", desc: "Profile, performance and reviews; supported edits" },
  { key: "serp", name: "SERP provider", letter: "S", desc: "DataForSEO: local pack and organic rankings" },
  { key: "anthropic", name: "Anthropic", letter: "A", desc: "Classification, recommendation text, reports and drafts" },
  { key: "slack", name: "Slack", letter: "#", desc: "Notifications when something needs you" },
] as const;

export function IntegrationsSettings({
  rows,
  githubInstallUrl,
  githubConfigured,
  env,
}: {
  rows: Row[];
  githubInstallUrl: string | null;
  githubConfigured: boolean;
  env: { anthropic: boolean; serp: boolean; google: boolean; siteguru: boolean; slack: boolean };
}) {
  return (
    <div>
      {PROVIDERS.map((p) => {
        const r = rows.find((x) => x.provider === p.key);
        let status = r?.status ?? "not_connected";
        // Key-based providers: configured env means connected unless calls are failing.
        if (p.key === "anthropic" && env.anthropic && status === "not_connected") status = "connected";
        if (p.key === "serp" && env.serp && status === "not_connected") status = "connected";
        if (p.key === "slack" && env.slack && status === "not_connected") status = "connected";
        let action: React.ReactNode = null;
        if (p.key === "github") {
          action = githubInstallUrl ? (
            <a href={githubInstallUrl} className="text-[13px] font-medium hover:underline">
              {status === "connected" ? "Manage installation ↗" : "Install GitHub App ↗"}
            </a>
          ) : (
            <span className="text-[12px] text-subtle-2">Set GITHUB_APP_* env vars</span>
          );
          if (!githubConfigured && githubInstallUrl) action = <span className="text-[12px] text-subtle-2">Set GITHUB_APP_ID and key</span>;
        } else if (p.key === "gbp") {
          action = <span className="text-[12px] text-subtle-2">{env.google ? "Google sign-in arrives in Phase 6" : "Set GOOGLE_CLIENT_* env vars"}</span>;
        } else if (p.key === "slack") {
          action = (
            <Link href="/settings/notifications" className="text-[13px] font-medium hover:underline">
              {env.slack ? "Change webhook" : "Add webhook"}
            </Link>
          );
        } else {
          const envName = { siteguru: "SITEGURU_API_KEY", serp: "DATAFORSEO_LOGIN / PASSWORD", anthropic: "ANTHROPIC_API_KEY" }[p.key];
          action = <span className="text-[12px] text-subtle-2">API key: {envName}</span>;
        }
        return <IntegrationRow key={p.key} p={p} status={status} r={r} action={action} />;
      })}
      <div className="flex items-center gap-3 border-b border-line py-3.5 opacity-50">
        <Logo letter="M" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">Gmail</div>
          <div className="text-[13px] text-muted">Draft monthly report emails automatically</div>
        </div>
        <span className="text-[13px] text-subtle-2">Coming later</span>
      </div>
    </div>
  );
}

function Logo({ letter }: { letter: string }) {
  return <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line text-[12px] font-semibold text-ink-3">{letter}</div>;
}

function IntegrationRow({
  p,
  status,
  r,
  action,
}: {
  p: { name: string; letter: string; desc: string };
  status: string;
  r: Row | undefined;
  action: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const label = status === "connected" ? "Connected" : status === "error" ? "Error" : "Not connected";
  return (
    <div className="border-b border-line py-3.5">
      <div className="flex items-start gap-3">
        <Logo letter={p.letter} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2">
            <span className="font-medium">{p.name}</span>
            <span className={cx("text-[13px] font-medium", status === "connected" ? "text-positive" : status === "error" ? "text-negative" : "text-subtle-2")}>{label}</span>
            {r?.account && <span className="text-[13px] text-muted">· {r.account}</span>}
          </div>
          <div className="text-[13px] text-muted">{p.desc}</div>
          <div className="mt-0.5 text-[12px] text-subtle-2">
            Last success: {r?.lastSuccessAt ? formatDateTime(r.lastSuccessAt) : "—"} · Last failure: {r?.lastFailureAt ? formatDateTime(r.lastFailureAt) : "—"}
          </div>
          {r?.lastError && (
            <button type="button" onClick={() => setOpen(!open)} className="mt-0.5 min-h-9 text-[12px] text-negative hover:underline md:min-h-0">
              {open ? "Hide last error" : "Show last error"}
            </button>
          )}
          {open && r?.lastError && <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-sidebar p-2 text-[12px] text-ink-3">{r.lastError}</pre>}
        </div>
        <div className="hidden shrink-0 md:block">{action}</div>
      </div>
      <div className="ml-11 mt-1 md:hidden">{action}</div>
    </div>
  );
}
