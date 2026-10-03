import { AppShell } from "@/components/shell/AppShell";
import { requirePageSession } from "@/lib/auth";
import { getShellData, getTiers } from "@/server/queries";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requirePageSession();
  const [shell, tiers] = await Promise.all([getShellData(), getTiers()]);
  return (
    <AppShell {...shell} newClient={{ tiers: tiers.map((t) => ({ id: t.id, name: t.name })) }}>
      {children}
    </AppShell>
  );
}
