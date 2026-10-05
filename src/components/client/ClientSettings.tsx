"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { OnboardingState } from "@/db/schema";
import { Button } from "@/components/ui/Button";
import { ChipInput } from "@/components/ui/ChipInput";
import { cx } from "@/components/ui/cx";
import { fieldInputClass, Modal } from "@/components/ui/Modal";
import { PropertyRow, propertyInputClass } from "@/components/ui/PropertyRow";
import { useToast } from "@/components/ui/Toast";
import { PlanBlogButton } from "./ReportActions";
import { ToggleRow } from "@/components/ui/Toggle";
import { useDebouncedSave } from "@/components/ui/useAutosave";
import { formatPounds, relativeTime, SCAN_LABEL } from "@/lib/format";
import {
  archiveClient,
  confirmAndActivate,
  retryOnboarding,
  setClientConnection,
  updateClientField,
  type ClientField,
} from "@/server/actions/clients";
import { listSiteguruSites, syncSiteguruNow } from "@/server/actions/integrations";

type ClientData = {
  id: string;
  name: string;
  status: string;
  tierId: string;
  websiteUrl: string;
  contactName: string;
  contactEmail: string;
  industry: string;
  primaryLocation: string;
  keywords: string[];
  services: string[];
  priorityServices: string[];
  locations: string[];
  excludedServices: string[];
  excludedLocations: string[];
  brandTone: string;
  autoApproveLowImpact: boolean;
  reviewBlogPosts: boolean;
  includeInMonthlyReport: boolean;
  paused: boolean;
  onboarding: OnboardingState;
  createdAt: string;
};

type TierData = { id: string; name: string; postsPerMonth: number; scanFrequency: "weekly" | "fortnightly" | "monthly"; pricePence: number };
type Connection = { provider: string; status: string; externalId: string | null; lastSuccessAt: string | null; lastError: string | null };

function Section({ title, sub, children }: { title: string; sub?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-9">
      <h2 className="text-[16px] font-semibold">{title}</h2>
      {sub && <p className="mb-3 mt-0.5 text-[13px] text-muted">{sub}</p>}
      {!sub && <div className="mb-2" />}
      {children}
    </section>
  );
}

export function ClientSettings({
  client,
  tiers,
  connections,
  blog,
}: {
  client: ClientData;
  tiers: TierData[];
  connections: Connection[];
  /** This month's blog posts: planned so far vs the tier's commitment. */
  blog?: { planned: number; committed: number };
}) {
  const router = useRouter();
  const toast = useToast();
  const [c, setC] = useState(client);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [pending, start] = useTransition();

  async function save(field: ClientField, value: unknown) {
    const r = await updateClientField(client.id, field, value);
    if (!r.ok) toast({ message: r.error });
    return r;
  }

  // One debounced saver per text field.
  const saveText = {
    websiteUrl: useDebouncedSave((v: string) => save("websiteUrl", v)),
    contactName: useDebouncedSave((v: string) => save("contactName", v)),
    contactEmail: useDebouncedSave((v: string) => save("contactEmail", v)),
    industry: useDebouncedSave((v: string) => save("industry", v)),
    primaryLocation: useDebouncedSave((v: string) => save("primaryLocation", v)),
    brandTone: useDebouncedSave((v: string) => save("brandTone", v)),
  };
  const setText = (k: keyof typeof saveText) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setC((x) => ({ ...x, [k]: v }));
    saveText[k](v);
  };
  const setChips = (k: "keywords" | "services" | "priorityServices" | "locations" | "excludedServices" | "excludedLocations") => (v: string[]) => {
    setC((x) => {
      const next = { ...x, [k]: v };
      if (k === "services") next.priorityServices = x.priorityServices.filter((p) => v.includes(p));
      return next;
    });
    void save(k, v);
  };
  const setToggle = (k: "autoApproveLowImpact" | "reviewBlogPosts" | "includeInMonthlyReport" | "paused") => async (v: boolean) => {
    setC((x) => ({ ...x, [k]: v }));
    const r = await save(k, v);
    if (r.ok && k === "paused") router.refresh();
  };

  const awaiting = client.status === "awaiting_confirmation";
  const onboarding = client.status === "onboarding";

  return (
    <div>
      {onboarding && <OnboardingProgress clientId={client.id} steps={client.onboarding} createdAt={client.createdAt} />}

      <Section title="Tier" sub="Sets how often content is created and the site is scanned.">
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">
          {tiers.map((t) => {
            const on = c.tierId === t.id;
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={on}
                onClick={async () => {
                  if (on) return;
                  setC((x) => ({ ...x, tierId: t.id }));
                  const r = await save("tierId", t.id);
                  if (r.ok) {
                    toast({ message: `${c.name} moved to ${t.name}` });
                    router.refresh();
                  }
                }}
                className={cx(
                  "rounded-lg border p-3.5 text-left transition-quiet hover:bg-row-hover",
                  on ? "border-ink shadow-[0_0_0_1px_var(--color-ink)]" : "border-line",
                )}
              >
                <div className="flex justify-between">
                  <span className="font-semibold">{t.name}</span>
                  <span className="text-muted">{formatPounds(t.pricePence)}/mo</span>
                </div>
                <div className="mt-1 text-[13px] text-muted">{t.postsPerMonth} blog posts / month</div>
                <div className="text-[13px] text-muted">{SCAN_LABEL[t.scanFrequency]} site scans</div>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Details">
        <PropertyRow label="Website">
          <input className={propertyInputClass} value={c.websiteUrl} onChange={setText("websiteUrl")} inputMode="url" autoCapitalize="none" />
        </PropertyRow>
        <PropertyRow label="Primary contact">
          <input className={propertyInputClass} value={c.contactName} onChange={setText("contactName")} placeholder="Empty" />
        </PropertyRow>
        <PropertyRow label="Contact email">
          <input className={propertyInputClass} value={c.contactEmail} onChange={setText("contactEmail")} type="email" placeholder="Empty" />
        </PropertyRow>
        <PropertyRow label="Industry">
          <input className={propertyInputClass} value={c.industry} onChange={setText("industry")} placeholder="Empty" />
        </PropertyRow>
        <PropertyRow label="Primary location">
          <input className={propertyInputClass} value={c.primaryLocation} onChange={setText("primaryLocation")} placeholder="Empty" />
        </PropertyRow>
        <PropertyRow label="Target keywords">
          <ChipInput values={c.keywords} onChange={setChips("keywords")} placeholder="Add keyword…" />
        </PropertyRow>
      </Section>

      <Section title="Strategy" sub="Recommendations and content only ever use these services and locations.">
        {awaiting && (
          <div className="mb-3 rounded-lg bg-sidebar px-3.5 py-3">
            <p>
              <strong className="font-semibold">
                We found {c.services.length} service{c.services.length === 1 ? "" : "s"} and {c.locations.length} location
                {c.locations.length === 1 ? "" : "s"} on the website.
              </strong>{" "}
              <span className="text-muted">Check them, then confirm to start recommendations. Tap ☆ to mark priority services.</span>
            </p>
            <Button
              className="mt-3 min-h-11 md:min-h-0"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await confirmAndActivate(client.id);
                  if (r.ok) {
                    toast({ message: `${c.name} is active` });
                    router.refresh();
                  } else toast({ message: r.error });
                })
              }
            >
              {pending ? "Activating…" : "Confirm and activate"}
            </Button>
          </div>
        )}
        <PropertyRow label="Services">
          <ChipInput
            values={c.services}
            onChange={setChips("services")}
            starred={c.priorityServices}
            onToggleStar={(v) => {
              const next = c.priorityServices.includes(v) ? c.priorityServices.filter((p) => p !== v) : [...c.priorityServices, v];
              setChips("priorityServices")(next);
            }}
            placeholder="Add service…"
          />
        </PropertyRow>
        <PropertyRow label="Locations served">
          <ChipInput values={c.locations} onChange={setChips("locations")} placeholder="Add location…" />
        </PropertyRow>
        <PropertyRow label="Excluded services">
          <ChipInput values={c.excludedServices} onChange={setChips("excludedServices")} placeholder="Add…" />
        </PropertyRow>
        <PropertyRow label="Excluded locations">
          <ChipInput values={c.excludedLocations} onChange={setChips("excludedLocations")} placeholder="Add…" />
        </PropertyRow>
        <PropertyRow label="Brand tone">
          <input className={propertyInputClass} value={c.brandTone} onChange={setText("brandTone")} placeholder="e.g. Friendly, plain English" />
        </PropertyRow>
      </Section>

      <Section title="Connections">
        <Connections clientId={client.id} connections={connections} />
      </Section>

      <Section title="Automation">
        <ToggleRow
          label="Auto-approve low-impact fixes"
          description="Alt text, schema markup and image compression skip review. They still arrive as a pull request."
          on={c.autoApproveLowImpact}
          onChange={setToggle("autoApproveLowImpact")}
        />
        <ToggleRow label="Review blog posts before publishing" description="Drafts appear in Recommendations first" on={c.reviewBlogPosts} onChange={setToggle("reviewBlogPosts")} />
        {client.status === "active" && !c.paused && blog && blog.committed > 0 && blog.planned < blog.committed && (
          <div className="border-b border-line py-3 text-[13px]">
            <div className="mb-0.5 text-muted">
              {blog.planned} of {blog.committed} blog posts planned this month.
            </div>
            <PlanBlogButton clientId={client.id} />
          </div>
        )}
        <ToggleRow
          label="Include in monthly report"
          description="Generate a summary for this client on the 1st"
          on={c.includeInMonthlyReport}
          onChange={setToggle("includeInMonthlyReport")}
        />
        <ToggleRow label="Pause automation" description="Stop scans and executions for this client" on={c.paused} onChange={setToggle("paused")} />
      </Section>

      {client.status !== "archived" && (
        <button
          type="button"
          onClick={() => setConfirmArchive(true)}
          className="-ml-2 min-h-11 rounded px-2 py-1 text-negative transition-quiet hover:bg-tag-red md:min-h-0"
        >
          Archive client
        </button>
      )}

      <Modal open={confirmArchive} onClose={() => setConfirmArchive(false)} title={`Archive ${c.name}?`} subtitle="Scans and executions stop. You can restore the client from “Show archived” on the Clients page.">
        <div className="flex justify-end gap-2">
          <Button variant="secondary" className="min-h-11 md:min-h-0" onClick={() => setConfirmArchive(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            className="min-h-11 md:min-h-0"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await archiveClient(client.id);
                if (r.ok) {
                  setConfirmArchive(false);
                  router.push("/");
                  toast({ message: `${c.name} archived` });
                } else toast({ message: r.error });
              })
            }
          >
            Archive
          </Button>
        </div>
      </Modal>
    </div>
  );
}

const STEP_LABEL: Record<string, string> = {
  website: "Check website",
  github: "Check GitHub repository",
  setup_pr: "Open setup pull request",
  siteguru: "Match SiteGuru site",
  gbp: "Match Google Business Profile",
  crawl: "Crawl the site",
  discovery: "Find services and locations",
  siteguru_sync: "First SiteGuru sync",
};

function OnboardingProgress({ clientId, steps, createdAt }: { clientId: string; steps: OnboardingState; createdAt: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [now] = useState(() => Date.now());
  const nothingStarted = !Object.values(steps).some((s) => s && s.status !== "pending");
  const stalled = nothingStarted && now - new Date(createdAt).getTime() > 2 * 60_000;
  const failedToStart = steps.website?.status === "failed" && steps.website.message?.startsWith("Background jobs");
  return (
    <div className="mb-9 rounded-lg bg-sidebar px-3.5 py-3">
      <p className="mb-2 font-semibold">Setting up this client…</p>
      {(stalled || failedToStart) && (
        <p className="mb-2 text-[13px] text-negative">
          {failedToStart
            ? "The app couldn’t start the setup job."
            : "Setup hasn’t started after 2 minutes. Background jobs (Inngest) probably aren’t connected to this deployment."}{" "}
          Check that the Inngest integration is installed in Vercel and the app is synced in Inngest, then start again.
        </p>
      )}
      <ul className="text-[13px]">
        {Object.entries(STEP_LABEL).map(([k, label]) => {
          const s = steps[k];
          const st = s?.status ?? "pending";
          return (
            <li key={k} className="flex gap-2 py-0.5">
              <span className={cx("w-4 shrink-0 text-center", st === "ok" ? "text-positive" : st === "failed" ? "text-negative" : "text-subtle-2")}>
                {st === "ok" ? "✓" : st === "failed" ? "!" : st === "running" ? "…" : st === "skipped" ? "–" : "·"}
              </span>
              <span className={st === "pending" ? "text-subtle-2" : ""}>
                {label}
                {s?.message ? <span className="text-muted"> — {s.message}</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        disabled={pending}
        className="mt-2 min-h-11 text-[13px] font-medium underline decoration-faint underline-offset-2 hover:decoration-ink md:min-h-0"
        onClick={() =>
          start(async () => {
            const r = await retryOnboarding(clientId);
            toast({ message: r.ok ? "Setup restarted" : r.error });
            router.refresh();
          })
        }
      >
        {pending ? "Starting…" : "Start setup again"}
      </button>
    </div>
  );
}

const CONNECTION_ROWS = [
  { provider: "website", label: "Website" },
  { provider: "github", label: "GitHub repository" },
  { provider: "siteguru", label: "SiteGuru site" },
  { provider: "gbp", label: "Google Business Profile location" },
] as const;

const STATUS_TEXT: Record<string, { label: string; cls: string }> = {
  connected: { label: "Connected", cls: "text-positive" },
  not_found: { label: "Not found", cls: "text-negative" },
  error: { label: "Error", cls: "text-negative" },
  not_connected: { label: "Not connected", cls: "text-subtle-2" },
  pending: { label: "Checking…", cls: "text-subtle-2" },
};

function Connections({ clientId, connections }: { clientId: string; connections: Connection[] }) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, start] = useTransition();
  const [now] = useState(() => new Date());
  const [sgSites, setSgSites] = useState<{ domain: string; searchConsole: boolean | null }[] | null | "loading">(null);

  function openEditor(provider: string, current: string | null) {
    setDraft(current ?? "");
    if (editing === provider) return setEditing(null);
    setEditing(provider);
    if (provider === "siteguru") {
      setSgSites("loading");
      listSiteguruSites()
        .then((r) => setSgSites(r.ok ? r.sites : null))
        .catch(() => setSgSites(null));
    }
  }

  return (
    <div>
      {CONNECTION_ROWS.map((row) => {
        const conn = connections.find((x) => x.provider === row.provider);
        const st = STATUS_TEXT[conn?.status ?? "not_connected"]!;
        const editable = row.provider !== "website";
        const actionLabel = conn?.status === "connected" ? "Change" : conn?.status === "error" || conn?.status === "not_found" ? "Retry" : "Connect";
        return (
          <div key={row.provider} className="flex flex-col gap-1 border-b border-line py-3 md:flex-row md:items-center md:gap-4">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{row.label}</div>
              <div className="truncate text-[13px] text-muted">
                {conn?.externalId ?? "—"}
                {conn?.lastSuccessAt ? ` · synced ${relativeTime(conn.lastSuccessAt, now)}` : ""}
              </div>
              {conn?.lastError && conn.status !== "connected" && <div className="text-[13px] text-negative">{conn.lastError}</div>}
              {row.provider === "siteguru" && conn?.externalId && conn.status === "connected" && (
                <button
                  type="button"
                  disabled={pending}
                  className="min-h-9 text-[13px] font-medium hover:underline md:min-h-0"
                  onClick={() =>
                    start(async () => {
                      const r = await syncSiteguruNow(clientId);
                      toast({ message: r.ok ? "Syncing with SiteGuru — this takes a few seconds" : r.error });
                    })
                  }
                >
                  Sync now
                </button>
              )}
              {editing === row.provider && (
                <form
                  className="mt-2 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    start(async () => {
                      const r = await setClientConnection(clientId, row.provider as "siteguru" | "gbp" | "github", draft);
                      toast({ message: r.ok ? `${row.label} updated` : r.error });
                      if (r.ok) {
                        setEditing(null);
                        router.refresh();
                      }
                    });
                  }}
                >
                  {row.provider === "siteguru" && Array.isArray(sgSites) && sgSites.length > 0 ? (
                    <select className={fieldInputClass} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus>
                      <option value="">Choose a SiteGuru site…</option>
                      {sgSites.map((site) => (
                        <option key={site.domain} value={site.domain}>
                          {site.domain}
                          {site.searchConsole === false ? " (no Search Console)" : ""}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className={fieldInputClass}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder={
                        row.provider === "github"
                          ? "owner/name"
                          : row.provider === "siteguru"
                            ? sgSites === "loading"
                              ? "Loading SiteGuru sites…"
                              : "www.example.co.uk"
                            : "locations/123…"
                      }
                      autoFocus
                      autoCapitalize="none"
                    />
                  )}
                  <Button type="submit" disabled={pending || !draft.trim()} className="min-h-11 md:min-h-0">
                    Save
                  </Button>
                </form>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className={cx("text-[13px] font-medium", st.cls)}>{st.label}</span>
              {editable && (
                <Button
                  variant="neutral"
                  className="min-h-11 md:min-h-0"
                  disabled={pending}
                  onClick={() => {
                    if (actionLabel === "Retry" && row.provider === "siteguru" && conn?.externalId) {
                      start(async () => {
                        const r = await syncSiteguruNow(clientId);
                        toast({ message: r.ok ? "Syncing with SiteGuru — this takes a few seconds" : r.error });
                        router.refresh();
                      });
                    } else if (actionLabel === "Retry") {
                      start(async () => {
                        const r = await retryOnboarding(clientId);
                        toast({ message: r.ok ? "Checking connections again" : r.error });
                        router.refresh();
                      });
                    } else {
                      openEditor(row.provider, conn?.externalId ?? null);
                    }
                  }}
                >
                  {actionLabel}
                </Button>
              )}
            </div>
          </div>
        );
      })}
      <p className="mt-2 text-[12px] text-subtle-2">
        SiteGuru sites come from your SiteGuru key (Settings → Integrations) and sync daily at 05:00. Google Business Profile locations arrive with the GBP integration.
      </p>
    </div>
  );
}
