import { notFound } from "next/navigation";
import { ActivityLog } from "@/components/settings/ActivityLog";
import { GeneralSettings } from "@/components/settings/GeneralSettings";
import { IntegrationsSettings } from "@/components/settings/IntegrationsSettings";
import { NotificationSettings } from "@/components/settings/NotificationSettings";
import { TiersSettings } from "@/components/settings/TiersSettings";
import { Tabs } from "@/components/ui/Tabs";
import { PropertyRow } from "@/components/ui/PropertyRow";
import { githubConfigured, githubInstallUrl } from "@/integrations/github";
import { keySource } from "@/integrations/keys";
import {
  getAllClientsBrief,
  getAuditLog,
  getIntegrations,
  getTierClientCounts,
  getTiers,
  getWorkspace,
} from "@/server/queries";

const TABS = [
  { key: "general", label: "General" },
  { key: "tiers", label: "Tiers" },
  { key: "strategy", label: "Strategy" },
  { key: "integrations", label: "Integrations" },
  { key: "notifications", label: "Notifications" },
  { key: "activity", label: "Activity" },
];

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ tab: string }>;
  searchParams: Promise<{ page?: string; client?: string }>;
}) {
  const { tab } = await params;
  if (!TABS.some((t) => t.key === tab)) notFound();
  const sp = await searchParams;
  const ws = await getWorkspace();

  let body: React.ReactNode = null;
  if (tab === "general") {
    body = (
      <GeneralSettings
        ws={{
          name: ws.name,
          senderName: ws.senderName,
          replyTo: ws.replyTo,
          signoff: ws.signoff,
          undoWindowSeconds: ws.undoWindowSeconds,
          recsPerScan: ws.recsPerScan,
          minScore: ws.minScore,
          scanDay: ws.scanDay,
          scanTime: ws.scanTime,
        }}
      />
    );
  } else if (tab === "tiers") {
    const [tiers, counts] = await Promise.all([getTiers(), getTierClientCounts()]);
    body = <TiersSettings tiers={tiers.map((t) => ({ ...t, clients: counts[t.id] ?? 0 }))} />;
  } else if (tab === "strategy") {
    body = (
      <div>
        <p className="mb-3 text-[13px] text-muted">How recommendations are weighted across categories. Custom weighting arrives in a later phase.</p>
        <PropertyRow label="Mode" labelWidth={180}>
          <div className="py-1.5">Automatic</div>
        </PropertyRow>
        {[
          ["Technical", 25],
          ["Existing pages", 20],
          ["New pages", 20],
          ["Local/GBP", 15],
          ["Content", 10],
          ["Internal links", 5],
          ["Authority/links", 5],
        ].map(([k, v]) => (
          <PropertyRow key={k} label={k} labelWidth={180}>
            <div className="py-1.5 text-muted">{v}</div>
          </PropertyRow>
        ))}
      </div>
    );
  } else if (tab === "integrations") {
    const [rows, siteguruKey, anthropicKey] = await Promise.all([getIntegrations(), keySource("siteguru"), keySource("anthropic")]);
    body = (
      <IntegrationsSettings
        keys={{ siteguru: siteguruKey, anthropic: anthropicKey }}
        canStoreKeys={!!process.env.ENCRYPTION_KEY}
        githubInstallUrl={githubInstallUrl()}
        githubConfigured={githubConfigured()}
        env={{
          anthropic: !!anthropicKey,
          serp: !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD),
          google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
          siteguru: !!siteguruKey,
          slack: !!ws.slackWebhookUrlEnc,
          inngest: !!(process.env.INNGEST_EVENT_KEY && process.env.INNGEST_SIGNING_KEY) || process.env.INNGEST_DEV === "1",
        }}
        rows={rows.map((r) => ({
          provider: r.provider,
          status: r.status,
          lastSuccessAt: r.lastSuccessAt?.toISOString() ?? null,
          lastFailureAt: r.lastFailureAt?.toISOString() ?? null,
          lastError: r.lastError,
          account: typeof r.config?.account === "string" ? r.config.account : null,
        }))}
      />
    );
  } else if (tab === "notifications") {
    body = <NotificationSettings prefs={ws.notifications} hasWebhook={!!ws.slackWebhookUrlEnc} />;
  } else if (tab === "activity") {
    const page = Math.max(0, Number(sp.page ?? 0) || 0);
    const clientId = sp.client && /^[0-9a-f-]{36}$/i.test(sp.client) ? sp.client : null;
    const [log, clients] = await Promise.all([getAuditLog(page, clientId), getAllClientsBrief()]);
    body = (
      <ActivityLog
        page={page}
        clientId={clientId}
        hasMore={log.hasMore}
        clients={clients}
        rows={log.rows.map(({ entry, clientName }) => ({
          id: entry.id,
          at: entry.at.toISOString(),
          actor: entry.actor,
          clientName,
          event: entry.event,
          before: entry.before,
          after: entry.after,
          meta: entry.meta,
        }))}
      />
    );
  }

  return (
    <div>
      <h1 className="mb-1.5 text-[28px] font-bold leading-tight tracking-[-0.02em] md:text-[36px]">Settings</h1>
      <p className="text-muted">Workspace defaults, tiers and connected tools.</p>
      <Tabs className="mb-6 mt-6" active={tab} items={TABS.map((t) => ({ ...t, href: `/settings/${t.key}` }))} />
      {body}
    </div>
  );
}
