"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { logout } from "@/app/login/actions";
import { cx } from "@/components/ui/cx";
import { ToastProvider } from "@/components/ui/Toast";
import { relativeTime } from "@/lib/format";
import { NewClientModal, type NewClientModalProps } from "@/components/clients/NewClientModal";

export type ShellProps = {
  workspaceName: string;
  clients: { id: string; name: string; pending: number }[];
  attentionCount: number;
  latestSync: string | null;
  syncByClient: Record<string, string>;
  newClient: Omit<NewClientModalProps, "open" | "onClose">;
  children: React.ReactNode;
};

const TAB_LABEL: Record<string, string> = {
  recommendations: "Recommendations",
  actioned: "Actioned",
  reports: "Reports",
  settings: "Settings",
};

function initials(name: string) {
  return name
    .replace(/&/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

type Crumb = { label: string; href?: string };

function crumbsFor(pathname: string, clients: ShellProps["clients"]): Crumb[] {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "clients" && parts[1]) {
    const name = clients.find((c) => c.id === parts[1])?.name ?? "Client";
    const tab = parts[2] ?? "recommendations";
    const base = `/clients/${parts[1]}`;
    const crumbs: Crumb[] = [{ label: "Clients", href: "/" }, { label: name, href: `${base}/recommendations` }];
    if (tab === "reports" && parts[3]) crumbs.push({ label: "Reports", href: `${base}/reports` }, { label: "Report" });
    else crumbs.push({ label: TAB_LABEL[tab] ?? tab });
    return crumbs;
  }
  if (parts[0] === "settings") return [{ label: "Settings" }];
  if (parts[0] === "attention") return [{ label: "Needs attention" }];
  return [{ label: "Clients" }];
}

export function AppShell(props: ShellProps) {
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [now, setNow] = useState<Date | null>(null);

  // Close the drawer on navigation (adjusting state during render, not in an effect).
  const [prevPath, setPrevPath] = useState(pathname);
  if (prevPath !== pathname) {
    setPrevPath(pathname);
    setDrawer(false);
  }
  useEffect(() => {
    const tick = () => setNow(new Date());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);

  const crumbs = crumbsFor(pathname, props.clients);
  const clientId = pathname.startsWith("/clients/") ? pathname.split("/")[2] : undefined;
  const syncAt = clientId ? props.syncByClient[clientId] : props.latestSync;
  const back = crumbs.length > 1 ? crumbs[crumbs.length - 2] : undefined;

  const sidebar = (
    <nav className="flex h-full flex-col gap-0.5 overflow-y-auto bg-sidebar px-2 pb-[calc(10px+env(safe-area-inset-bottom))] pt-[calc(10px+env(safe-area-inset-top))]">
      <div className="flex items-center gap-2 px-2 pb-3.5 pt-1.5">
        <div className="flex size-[22px] items-center justify-center rounded-[5px] bg-ink text-[11px] font-bold text-white">
          {initials(props.workspaceName)}
        </div>
        <div className="truncate text-[14px] font-semibold">{props.workspaceName}</div>
      </div>
      <NavItem href="/attention" active={pathname === "/attention"}>
        <span>Needs attention</span>
        {props.attentionCount > 0 && <Pill n={props.attentionCount} />}
      </NavItem>
      <NavItem href="/" active={pathname === "/"}>
        <span>Clients</span>
        <span className="text-[12px] text-subtle-2">{props.clients.length}</span>
      </NavItem>
      <NavItem href="/settings/general" active={pathname.startsWith("/settings")}>
        <span>Settings</span>
      </NavItem>
      <div className="px-2 pb-1 pt-[18px] text-[12px] font-medium text-subtle-2">Your clients</div>
      {props.clients.map((c) => (
        <Link
          key={c.id}
          href={`/clients/${c.id}/recommendations`}
          className={cx(
            "flex min-h-11 items-center gap-2 rounded-[5px] px-2 py-1 text-ink-2 transition-quiet hover:bg-hover-2 md:min-h-0",
            clientId === c.id && "bg-hover-2",
          )}
        >
          <span className="min-w-0 flex-1 truncate">{c.name}</span>
          {c.pending > 0 && <Pill n={c.pending} />}
        </Link>
      ))}
      <button
        type="button"
        onClick={() => {
          setDrawer(false);
          setAddOpen(true);
        }}
        className="flex min-h-11 items-center rounded-[5px] px-2 py-1 text-left text-subtle-2 transition-quiet hover:bg-hover-2 hover:text-ink-2 md:min-h-0"
      >
        + Add client
      </button>
      <div className="flex-1" />
      <form action={logout}>
        <button type="submit" className="flex min-h-11 w-full items-center rounded-[5px] px-2 py-1 text-left text-[13px] text-subtle-2 transition-quiet hover:bg-hover-2 hover:text-ink-2 md:min-h-0">
          Sign out
        </button>
      </form>
    </nav>
  );

  return (
    <ToastProvider>
      <div className="flex h-dvh w-full overflow-hidden">
        <aside className="hidden w-60 shrink-0 border-r border-line md:block">{sidebar}</aside>

        {/* Mobile drawer */}
        <div className={cx("fixed inset-0 z-30 md:hidden", drawer ? "" : "pointer-events-none")} aria-hidden={!drawer}>
          <div
            className={cx("absolute inset-0 bg-[rgba(15,15,15,0.35)] transition-opacity duration-150", drawer ? "opacity-100" : "opacity-0")}
            onClick={() => setDrawer(false)}
          />
          <aside
            className={cx(
              "absolute inset-y-0 left-0 w-[280px] max-w-[85vw] border-r border-line shadow-modal transition-transform duration-150",
              drawer ? "translate-x-0" : "-translate-x-full",
            )}
          >
            {sidebar}
          </aside>
        </div>

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-11 shrink-0 items-center justify-between gap-3 px-2 pt-[env(safe-area-inset-top)] md:px-4 md:pt-0">
            <div className="flex min-w-0 items-center gap-1 text-muted">
              <button
                type="button"
                aria-label="Open menu"
                onClick={() => setDrawer(true)}
                className="flex size-11 shrink-0 items-center justify-center rounded text-ink-3 md:hidden"
              >
                <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
                  <path d="M2 4.5h14M2 9h14M2 13.5h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
              {/* Mobile: back chevron + current title */}
              <div className="flex min-w-0 items-center md:hidden">
                {back?.href && (
                  <Link href={back.href} aria-label={`Back to ${back.label}`} className="flex size-11 shrink-0 items-center justify-center text-muted">
                    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                      <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </Link>
                )}
                <span className="truncate font-medium text-ink">{crumbs[crumbs.length - 1]?.label}</span>
              </div>
              {/* Desktop breadcrumbs */}
              <div className="hidden min-w-0 items-center gap-1 md:flex">
                {crumbs.map((c, i) => (
                  <div key={i} className="flex min-w-0 items-center gap-1">
                    {i > 0 && <span className="text-faint">/</span>}
                    {c.href && i < crumbs.length - 1 ? (
                      <Link href={c.href} className="whitespace-nowrap rounded px-1.5 py-0.5 text-muted transition-quiet hover:bg-hover">
                        {c.label}
                      </Link>
                    ) : (
                      <span className="truncate whitespace-nowrap px-1.5 py-0.5 text-ink">{c.label}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="hidden whitespace-nowrap text-[12px] text-subtle-2 md:block" suppressHydrationWarning>
              {syncAt ? `Synced with SiteGuru ${now ? relativeTime(syncAt, now) : ""}` : "Not synced with SiteGuru yet"}
            </div>
          </header>
          <div className="flex-1 overflow-y-auto" id="content-scroll">
            <div className="mx-auto max-w-[920px] px-4 pb-[120px] pt-5 md:px-12 md:pt-9">{props.children}</div>
          </div>
        </main>
      </div>
      <NewClientModal {...props.newClient} open={addOpen} onClose={() => setAddOpen(false)} />
      <OpenNewClientListener onOpen={() => setAddOpen(true)} />
    </ToastProvider>
  );
}

/** Lets other components (e.g. the dashboard's "New client" button) open the modal. */
function OpenNewClientListener({ onOpen }: { onOpen: () => void }) {
  useEffect(() => {
    const h = () => onOpen();
    window.addEventListener("open-new-client", h);
    return () => window.removeEventListener("open-new-client", h);
  }, [onOpen]);
  return null;
}

function NavItem({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cx(
        "flex min-h-11 items-center justify-between rounded-[5px] px-2 py-[5px] font-medium text-ink-2 transition-quiet hover:bg-hover-2 md:min-h-0",
        active && "bg-hover-2",
      )}
    >
      {children}
    </Link>
  );
}

function Pill({ n }: { n: number }) {
  return <span className="rounded-[9px] bg-tag-red px-1.5 text-[11px] font-semibold leading-[17px] text-tag-red-fg">{n}</span>;
}
