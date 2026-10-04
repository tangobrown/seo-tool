"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { cx } from "@/components/ui/cx";
import { fieldInputClass } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { formatDateTime } from "@/lib/format";
import { saveIntegrationKey, testIntegration } from "@/server/actions/integrations";

type KeySource = "app" | "env" | null;

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
  keys,
  canStoreKeys,
}: {
  rows: Row[];
  keys: { siteguru: KeySource; anthropic: KeySource };
  canStoreKeys: boolean;
  githubInstallUrl: string | null;
  githubConfigured: boolean;
  env: { anthropic: boolean; serp: boolean; google: boolean; siteguru: boolean; slack: boolean; inngest: boolean };
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
        } else if (p.key === "serp") {
          action = <span className="text-[12px] text-subtle-2">DataForSEO arrives in Phase 7</span>;
        }
        const keyed = p.key === "siteguru" || p.key === "anthropic" ? p.key : null;
        return (
          <IntegrationRow key={p.key} p={p} status={status} r={r} action={action}>
            {keyed && <KeyEditor provider={keyed} source={keys[keyed]} canStore={canStoreKeys} />}
          </IntegrationRow>
        );
      })}
      <IntegrationRow
        p={{ name: "Inngest", letter: "In", desc: "Background jobs: onboarding, scans, syncs and Claude Code runs" }}
        status={env.inngest ? "connected" : "not_connected"}
        r={undefined}
        action={<span className="text-[12px] text-subtle-2">{env.inngest ? "Keys set" : "Install the Inngest integration in Vercel"}</span>}
      />
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
  children,
}: {
  p: { name: string; letter: string; desc: string };
  status: string;
  r: Row | undefined;
  action: React.ReactNode;
  children?: React.ReactNode;
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
          {children}
        </div>
        <div className="hidden shrink-0 md:block">{action}</div>
      </div>
      <div className="ml-11 mt-1 md:hidden">{action}</div>
    </div>
  );
}

const KEY_HELP = {
  siteguru: { label: "SiteGuru API key", where: "SiteGuru → API access → create a key (needs a plan with MCP access).", env: "SITEGURU_API_KEY" },
  anthropic: { label: "Anthropic API key", where: "console.anthropic.com → API keys.", env: "ANTHROPIC_API_KEY" },
} as const;

function KeyEditor({ provider, source, canStore }: { provider: "siteguru" | "anthropic"; source: KeySource; canStore: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [pending, start] = useTransition();
  const help = KEY_HELP[provider];

  const run = (fn: () => Promise<void>) => start(async () => { await fn(); router.refresh(); });

  return (
    <div className="mt-2 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-muted">
          {source === "app" ? "Key saved (encrypted)" : source === "env" ? `Using ${help.env} from Vercel` : "No key yet"}
        </span>
        <button type="button" className="min-h-9 font-medium hover:underline md:min-h-0" onClick={() => setEditing(!editing)}>
          {source ? "Replace key" : "Add key"}
        </button>
        {source && (
          <button
            type="button"
            disabled={pending}
            className="min-h-9 font-medium hover:underline md:min-h-0"
            onClick={() =>
              run(async () => {
                const r = await testIntegration(provider);
                toast({ message: r.ok ? r.message : r.error, durationMs: 6000 });
              })
            }
          >
            {pending ? "Testing…" : "Test connection"}
          </button>
        )}
        {source === "app" && (
          <button
            type="button"
            disabled={pending}
            className="min-h-9 text-negative hover:underline md:min-h-0"
            onClick={() =>
              run(async () => {
                const r = await saveIntegrationKey(provider, "");
                toast({ message: r.ok ? "Key removed" : r.error });
              })
            }
          >
            Remove
          </button>
        )}
      </div>
      {editing && (
        <form
          className="mt-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const r = await saveIntegrationKey(provider, value);
              if (!r.ok) return toast({ message: r.error });
              setEditing(false);
              setValue("");
              const t = await testIntegration(provider);
              toast({ message: t.ok ? `Key saved. ${t.message}` : `Key saved, but the test failed: ${t.error}`, durationMs: 8000 });
            });
          }}
        >
          <p className="mb-1.5 text-subtle-2">{help.where}</p>
          {!canStore && <p className="mb-1.5 text-negative">Set ENCRYPTION_KEY in Vercel first, so keys can be stored encrypted.</p>}
          <div className="flex flex-col gap-2 md:flex-row">
            <input
              className={fieldInputClass}
              type="password"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={help.label}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <Button type="submit" disabled={pending || !value.trim() || !canStore} className="min-h-11 md:min-h-0">
              {pending ? "Saving…" : "Save and test"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
