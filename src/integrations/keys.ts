import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { integrations } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";

/** Providers whose API key can be entered in Settings → Integrations, and the env var each falls back to. */
export const KEYED_PROVIDERS = {
  anthropic: "ANTHROPIC_API_KEY",
  /** The Google Cloud service account's JSON key file, pasted whole. */
  gsc: "GOOGLE_SERVICE_ACCOUNT_JSON",
  /** "login:password"; the env fallback joins DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD. */
  dataforseo: "DATAFORSEO_LOGIN",
  /** Optional. PageSpeed Insights works without a key at low volume. */
  pagespeed: "GOOGLE_PAGESPEED_API_KEY",
} as const;

function envValue(provider: KeyedProvider): string | null {
  if (provider === "dataforseo") {
    const { DATAFORSEO_LOGIN: login, DATAFORSEO_PASSWORD: password } = process.env;
    return login && password ? `${login}:${password}` : null;
  }
  return process.env[KEYED_PROVIDERS[provider]] || null;
}

export type KeyedProvider = keyof typeof KEYED_PROVIDERS;

/** The key entered in the app (encrypted in Postgres) wins; the env var is the fallback. */
export async function getProviderKey(provider: KeyedProvider): Promise<string | null> {
  const [row] = await db.select({ secretEnc: integrations.secretEnc }).from(integrations).where(eq(integrations.provider, provider));
  if (row?.secretEnc) {
    try {
      return decrypt(row.secretEnc);
    } catch {
      // ENCRYPTION_KEY changed or missing: fall through to the env var rather than failing silently later.
      console.error(`Could not decrypt the stored ${provider} key; check ENCRYPTION_KEY`);
    }
  }
  return envValue(provider);
}

export async function keySource(provider: KeyedProvider): Promise<"app" | "env" | null> {
  const [row] = await db.select({ secretEnc: integrations.secretEnc }).from(integrations).where(eq(integrations.provider, provider));
  if (row?.secretEnc) return "app";
  return envValue(provider) ? "env" : null;
}

export async function setProviderKey(provider: KeyedProvider, key: string | null) {
  const secretEnc = key ? encrypt(key) : null;
  await db
    .insert(integrations)
    .values({ provider, secretEnc })
    .onConflictDoUpdate({ target: integrations.provider, set: { secretEnc, lastError: null } });
}
