"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { clientConnections, clients, tiers } from "@/db/schema";
import { EVENTS, inngest } from "@/jobs/client";
import { audit } from "@/lib/audit";
import { requireSession } from "@/lib/auth";
import { resolveAttention } from "@/lib/attention";
import { normaliseDomain } from "@/lib/format";
import type { ActionResult } from "./recommendations";

const uuid = z.string().uuid();
const chips = z.array(z.string().trim().min(1).max(120)).max(100);

// Whitelist of autosaved client fields and how to validate each.
const FIELD_SCHEMAS = {
  websiteUrl: z.string().trim().max(300),
  contactName: z.string().trim().max(200),
  contactEmail: z.union([z.literal(""), z.string().trim().email().max(320)]),
  industry: z.string().trim().max(200),
  primaryLocation: z.string().trim().max(200),
  brandTone: z.string().trim().max(300),
  keywords: chips,
  services: chips,
  priorityServices: chips,
  locations: chips,
  excludedServices: chips,
  excludedLocations: chips,
  autoApproveLowImpact: z.boolean(),
  reviewBlogPosts: z.boolean(),
  includeInMonthlyReport: z.boolean(),
  paused: z.boolean(),
  tierId: uuid,
} as const;

export type ClientField = keyof typeof FIELD_SCHEMAS;

export async function updateClientField(clientId: string, field: ClientField, value: unknown): Promise<ActionResult> {
  await requireSession();
  if (!uuid.safeParse(clientId).success || !(field in FIELD_SCHEMAS)) return { ok: false, error: "Invalid request" };
  const parsed = FIELD_SCHEMAS[field].safeParse(value);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid value" };
  let v = parsed.data;

  const [before] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!before) return { ok: false, error: "Client not found" };

  const patch: Partial<typeof clients.$inferInsert> = { [field]: v };
  if (field === "websiteUrl") {
    const raw = String(v);
    v = raw && !/^https?:\/\//i.test(raw) ? `https://${raw}` : raw;
    patch.websiteUrl = v as string;
    patch.domain = normaliseDomain(raw);
  }
  if (field === "services") {
    // Priority services are a subset of services.
    patch.priorityServices = before.priorityServices.filter((p) => (v as string[]).includes(p));
  }
  if (field === "priorityServices") {
    patch.priorityServices = (v as string[]).filter((p) => before.services.includes(p));
  }
  if (field === "paused") {
    if (before.status === "active" || before.status === "paused") patch.status = v ? "paused" : "active";
  }
  if (field === "tierId") {
    const [t] = await db.select().from(tiers).where(eq(tiers.id, v as string));
    if (!t) return { ok: false, error: "Unknown tier" };
  }

  await db.update(clients).set(patch).where(eq(clients.id, clientId));
  await audit({
    actor: "operator",
    clientId,
    entityType: "client",
    entityId: clientId,
    event: `client.${field}.updated`,
    before: { [field]: before[field as keyof typeof before] },
    after: patch,
  });
  revalidatePath(`/clients/${clientId}`, "layout");
  if (field === "tierId" || field === "paused") revalidatePath("/", "layout");
  return { ok: true };
}

const newClientSchema = z.object({
  name: z.string().trim().min(1).max(200),
  website: z.string().trim().min(3).max(300),
  contactName: z.string().trim().max(200).default(""),
  contactEmail: z.union([z.literal(""), z.string().trim().email().max(320)]).default(""),
  tierId: uuid,
  githubRepo: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Use owner/name"),
});

export async function createClient(input: z.input<typeof newClientSchema>): Promise<ActionResult<{ clientId: string; name: string }>> {
  await requireSession();
  const parsed = newClientSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form" };
  const d = parsed.data;
  const domain = normaliseDomain(d.website);
  if (!domain.includes(".")) return { ok: false, error: "Enter a valid website" };

  const client = await db.transaction(async (tx) => {
    const [c] = await tx
      .insert(clients)
      .values({
        name: d.name,
        domain,
        websiteUrl: `https://${domain}`,
        contactName: d.contactName,
        contactEmail: d.contactEmail,
        tierId: d.tierId,
        githubRepo: d.githubRepo,
        status: "onboarding",
      })
      .returning();
    await tx.insert(clientConnections).values(
      ["website", "github", "siteguru", "gbp"].map((provider) => ({ clientId: c!.id, provider, status: "pending" as const })),
    );
    await audit({ actor: "operator", clientId: c!.id, entityType: "client", entityId: c!.id, event: "client.created", after: d }, tx);
    return c!;
  });

  try {
    await inngest.send({ name: EVENTS.clientOnboard, data: { clientId: client.id }, id: `onboard-${client.id}` });
  } catch (e) {
    console.error("Failed to start onboarding", e);
  }
  revalidatePath("/", "layout");
  return { ok: true, clientId: client.id, name: client.name };
}

export async function archiveClient(clientId: string): Promise<ActionResult> {
  await requireSession();
  if (!uuid.safeParse(clientId).success) return { ok: false, error: "Invalid request" };
  const [before] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!before) return { ok: false, error: "Client not found" };
  await db.update(clients).set({ status: "archived", archivedAt: new Date() }).where(eq(clients.id, clientId));
  await audit({ actor: "operator", clientId, entityType: "client", entityId: clientId, event: "client.archived", before: { status: before.status }, after: { status: "archived" } });
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function restoreClient(clientId: string): Promise<ActionResult> {
  await requireSession();
  if (!uuid.safeParse(clientId).success) return { ok: false, error: "Invalid request" };
  const [before] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!before) return { ok: false, error: "Client not found" };
  const status = before.paused ? "paused" : before.services.length ? "active" : "awaiting_confirmation";
  await db.update(clients).set({ status, archivedAt: null }).where(eq(clients.id, clientId));
  await audit({ actor: "operator", clientId, entityType: "client", entityId: clientId, event: "client.restored", before: { status: "archived" }, after: { status } });
  revalidatePath("/", "layout");
  return { ok: true };
}

/** "Confirm and activate" after onboarding discovery. */
export async function confirmAndActivate(clientId: string): Promise<ActionResult> {
  await requireSession();
  if (!uuid.safeParse(clientId).success) return { ok: false, error: "Invalid request" };
  const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!c) return { ok: false, error: "Client not found" };
  if (c.status !== "awaiting_confirmation") return { ok: false, error: "This client is already active." };
  if (!c.services.length || !c.locations.length) return { ok: false, error: "Add at least one service and one location first." };

  const [updated] = await db
    .update(clients)
    .set({ status: "active" })
    .where(and(eq(clients.id, clientId), eq(clients.status, "awaiting_confirmation")))
    .returning();
  if (!updated) return { ok: false, error: "This client is already active." };
  await audit({
    actor: "operator",
    clientId,
    entityType: "client",
    entityId: clientId,
    event: "client.activated",
    before: { status: "awaiting_confirmation" },
    after: { status: "active", services: c.services, priorityServices: c.priorityServices, locations: c.locations },
  });
  await resolveAttention(`confirm_client:${clientId}`);
  try {
    // SERP baseline + first scan arrive in Phases 4 and 7; the event is the hook for them.
    await inngest.send({ name: EVENTS.clientActivated, data: { clientId }, id: `activated-${clientId}` });
  } catch (e) {
    console.error(e);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Re-run onboarding (e.g. after adding the site to SiteGuru or installing the GitHub App). */
export async function retryOnboarding(clientId: string): Promise<ActionResult> {
  await requireSession();
  if (!uuid.safeParse(clientId).success) return { ok: false, error: "Invalid request" };
  await audit({ actor: "operator", clientId, entityType: "client", entityId: clientId, event: "client.onboarding_retried" });
  await inngest.send({ name: EVENTS.clientOnboard, data: { clientId, retry: true }, id: `onboard-${clientId}-${Date.now()}` });
  revalidatePath(`/clients/${clientId}`, "layout");
  return { ok: true };
}

export async function setClientConnection(clientId: string, provider: "siteguru" | "gbp" | "github", externalId: string): Promise<ActionResult> {
  await requireSession();
  const p = z.object({ clientId: uuid, provider: z.enum(["siteguru", "gbp", "github"]), externalId: z.string().trim().min(1).max(300) }).safeParse({ clientId, provider, externalId });
  if (!p.success) return { ok: false, error: "Invalid request" };
  const col = { siteguru: "siteguruSiteId", gbp: "gbpLocationId", github: "githubRepo" } as const;
  await db.update(clients).set({ [col[provider]]: externalId }).where(eq(clients.id, clientId));
  await db
    .update(clientConnections)
    // SiteGuru is "pending" until the first sync succeeds; the others are confirmed by the operator choosing them.
    .set(provider === "siteguru" ? { externalId, status: "pending", lastError: null } : { externalId, status: "connected", lastSuccessAt: new Date(), lastError: null })
    .where(and(eq(clientConnections.clientId, clientId), eq(clientConnections.provider, provider)));
  await audit({ actor: "operator", clientId, entityType: "client_connection", entityId: provider, event: "connection.set", after: { provider, externalId } });
  if (provider === "siteguru") {
    await resolveAttention(`siteguru_missing:${clientId}`);
    // Pull data for the newly linked site straight away rather than waiting for 05:00.
    await inngest.send({ name: EVENTS.siteguruSyncClient, data: { clientId }, id: `sg-link-${clientId}-${Date.now()}` }).catch((e) => console.error(e));
  }
  if (provider === "gbp") await resolveAttention(`gbp_match:${clientId}`);
  revalidatePath(`/clients/${clientId}`, "layout");
  return { ok: true };
}
