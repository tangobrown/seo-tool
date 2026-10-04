"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { testAnthropicKey } from "@/integrations/anthropic";
import { KEYED_PROVIDERS, setProviderKey, type KeyedProvider } from "@/integrations/keys";
import { siteguru } from "@/integrations/siteguru";
import { EVENTS, inngest } from "@/jobs/client";
import { audit } from "@/lib/audit";
import { requireSession } from "@/lib/auth";
import type { ActionResult } from "./recommendations";

const provider = z.enum(Object.keys(KEYED_PROVIDERS) as [KeyedProvider, ...KeyedProvider[]]);

/** Saves (or with "" removes) an integration key. Stored AES-256-GCM encrypted; never logged. */
export async function saveIntegrationKey(p: KeyedProvider, key: string): Promise<ActionResult> {
  await requireSession();
  const parsed = z.object({ p: provider, key: z.string().trim().max(500) }).safeParse({ p, key });
  if (!parsed.success) return { ok: false, error: "Invalid request" };
  if (!process.env.ENCRYPTION_KEY) return { ok: false, error: "Set ENCRYPTION_KEY in Vercel first, so the key can be stored encrypted." };
  await setProviderKey(parsed.data.p, parsed.data.key || null);
  await audit({ actor: "operator", entityType: "integration", entityId: parsed.data.p, event: parsed.data.key ? "integration.key_saved" : "integration.key_removed" });
  revalidatePath("/settings/integrations");
  return { ok: true };
}

/** Makes one real call with the saved key and reports what it found. */
export async function testIntegration(p: KeyedProvider): Promise<ActionResult<{ message: string }>> {
  await requireSession();
  if (!provider.safeParse(p).success) return { ok: false, error: "Invalid request" };
  try {
    if (p === "siteguru") {
      const sites = await siteguru.listSites();
      return { ok: true, message: `Connected — ${sites.length} site${sites.length === 1 ? "" : "s"} available` };
    }
    return { ok: true, message: `Connected — ${await testAnthropicKey()}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Test failed" };
  } finally {
    revalidatePath("/settings/integrations");
  }
}

export async function listSiteguruSites(): Promise<ActionResult<{ sites: { domain: string; searchConsole: boolean | null }[] }>> {
  await requireSession();
  try {
    const sites = await siteguru.listSites();
    return {
      ok: true,
      sites: sites.map((s) => ({
        domain: s.domain.replace(/^https?:\/\//, "").replace(/\/$/, ""),
        searchConsole: s.data_sources?.search_console?.connected ?? null,
      })),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "SiteGuru unavailable" };
  }
}

export async function syncSiteguruNow(clientId: string): Promise<ActionResult> {
  await requireSession();
  if (!z.string().uuid().safeParse(clientId).success) return { ok: false, error: "Invalid request" };
  await inngest.send({ name: EVENTS.siteguruSyncClient, data: { clientId }, id: `sg-manual-${clientId}-${Date.now()}` });
  await audit({ actor: "operator", clientId, entityType: "client_connection", entityId: "siteguru", event: "siteguru.sync_requested" });
  return { ok: true };
}
