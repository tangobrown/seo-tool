"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { tiers, workspace } from "@/db/schema";
import { slackProvider } from "@/integrations/slack";
import { audit } from "@/lib/audit";
import { requireSession } from "@/lib/auth";
import { decrypt, encrypt } from "@/lib/crypto";
import type { ActionResult } from "./recommendations";

const WORKSPACE_FIELDS = {
  name: z.string().trim().min(1).max(100),
  senderName: z.string().trim().max(200),
  replyTo: z.union([z.literal(""), z.string().trim().email().max(320)]),
  signoff: z.string().max(1000),
  undoWindowSeconds: z.coerce.number().int().min(10).max(3600),
  recsPerScan: z.coerce.number().int().min(1).max(50),
  minScore: z.coerce.number().int().min(0).max(100),
  scanDay: z.coerce.number().int().min(1).max(7),
  scanTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  deferDays: z.coerce.number().int().min(1).max(365),
  notifications: z.object({ newRecs: z.boolean(), reports: z.boolean(), weeklyDigest: z.boolean(), failures: z.boolean() }),
} as const;

export type WorkspaceField = keyof typeof WORKSPACE_FIELDS;

export async function updateWorkspaceField(field: WorkspaceField, value: unknown): Promise<ActionResult> {
  await requireSession();
  if (!(field in WORKSPACE_FIELDS)) return { ok: false, error: "Invalid field" };
  const parsed = WORKSPACE_FIELDS[field].safeParse(value);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid value" };
  const [before] = await db.select().from(workspace).where(eq(workspace.id, 1));
  await db.update(workspace).set({ [field]: parsed.data, updatedAt: new Date() }).where(eq(workspace.id, 1));
  await audit({
    actor: "operator",
    entityType: "workspace",
    event: `workspace.${field}.updated`,
    before: { [field]: before?.[field] },
    after: { [field]: parsed.data },
  });
  revalidatePath("/", "layout");
  return { ok: true };
}

const TIER_FIELDS = {
  postsPerMonth: z.coerce.number().int().min(0).max(60),
  scanFrequency: z.enum(["weekly", "fortnightly", "monthly"]),
  pricePence: z.coerce.number().int().min(0).max(100_000_000),
} as const;

export async function updateTierField(tierId: string, field: keyof typeof TIER_FIELDS, value: unknown): Promise<ActionResult> {
  await requireSession();
  if (!z.string().uuid().safeParse(tierId).success || !(field in TIER_FIELDS)) return { ok: false, error: "Invalid request" };
  const parsed = TIER_FIELDS[field].safeParse(value);
  if (!parsed.success) return { ok: false, error: "Invalid value" };
  const [before] = await db.select().from(tiers).where(eq(tiers.id, tierId));
  if (!before) return { ok: false, error: "Tier not found" };
  await db.update(tiers).set({ [field]: parsed.data }).where(eq(tiers.id, tierId));
  await audit({
    actor: "operator",
    entityType: "tier",
    entityId: tierId,
    event: `tier.${field}.updated`,
    before: { tier: before.name, [field]: before[field] },
    after: { tier: before.name, [field]: parsed.data },
  });
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function setSlackWebhook(url: string): Promise<ActionResult> {
  await requireSession();
  const parsed = z.union([z.literal(""), z.string().trim().url().startsWith("https://hooks.slack.com/")]).safeParse(url);
  if (!parsed.success) return { ok: false, error: "Use a Slack incoming webhook URL (https://hooks.slack.com/…)" };
  const [before] = await db.select().from(workspace).where(eq(workspace.id, 1));
  await db
    .update(workspace)
    .set({ slackWebhookUrlEnc: parsed.data ? encrypt(parsed.data) : null })
    .where(eq(workspace.id, 1));
  await audit({
    actor: "operator",
    entityType: "workspace",
    event: "workspace.slack_webhook.updated",
    // Never log the URL itself; it is a secret.
    before: { set: !!before?.slackWebhookUrlEnc },
    after: { set: !!parsed.data },
  });
  revalidatePath("/settings", "layout");
  return { ok: true };
}

export async function sendTestSlack(): Promise<ActionResult> {
  await requireSession();
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, 1));
  if (!ws?.slackWebhookUrlEnc) return { ok: false, error: "Add a webhook URL first." };
  try {
    await slackProvider(decrypt(ws.slackWebhookUrlEnc)).send("SEO Autopilot test message. Notifications are working.");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Slack test failed" };
  }
}
