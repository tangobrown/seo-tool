import "server-only";
import { createPrivateKey } from "node:crypto";
import { SignJWT } from "jose";
import { z } from "zod";
import type { GscRow } from "@/domain/gsc-signals";
import { getProviderKey } from "../keys";
import { callProvider, IntegrationError } from "../run";

// Google Search Console over its REST API, signed in as a service account. Each client adds the
// service account's email as a user on their Search Console property; no OAuth consent screen.

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const API = "https://www.googleapis.com/webmasters/v3";

const serviceAccountSchema = z.object({
  client_email: z.string().email(),
  private_key: z.string().includes("PRIVATE KEY"),
  token_uri: z.string().url().default("https://oauth2.googleapis.com/token"),
});
export type ServiceAccount = z.infer<typeof serviceAccountSchema>;

/** Validates a pasted service account key file. Returns a readable reason when it's wrong. */
export function parseServiceAccount(raw: string): { ok: true; value: ServiceAccount } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "That isn’t valid JSON. Paste the whole key file Google downloaded." };
  }
  const r = serviceAccountSchema.safeParse(json);
  if (!r.success) return { ok: false, error: "This doesn’t look like a service account key (it needs client_email and private_key)." };
  return { ok: true, value: { ...r.data, private_key: r.data.private_key.replace(/\\n/g, "\n") } };
}

async function serviceAccount(): Promise<ServiceAccount> {
  const raw = await getProviderKey("gsc");
  if (!raw) throw new IntegrationError("gsc", "No Google service account. Add one in Settings → Integrations.", false);
  const r = parseServiceAccount(raw);
  if (!r.ok) throw new IntegrationError("gsc", r.error, false);
  return r.value;
}

export async function gscServiceAccountEmail(): Promise<string | null> {
  const raw = await getProviderKey("gsc");
  if (!raw) return null;
  const r = parseServiceAccount(raw);
  return r.ok ? r.value.client_email : null;
}

let cachedToken: { email: string; token: string; expiresAt: number } | null = null;

async function accessToken(signal: AbortSignal): Promise<string> {
  const sa = await serviceAccount();
  if (cachedToken && cachedToken.email === sa.client_email && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(sa.client_email)
    .setAudience(sa.token_uri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(createPrivateKey(sa.private_key));
  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!res.ok || !body.access_token) {
    throw new IntegrationError("gsc", `Google sign-in failed: ${body.error_description ?? body.error ?? res.status}`, res.status >= 500);
  }
  cachedToken = { email: sa.client_email, token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return body.access_token;
}

async function gscFetch<T>(path: string, init: RequestInit, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
  const token = await accessToken(signal);
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, signal });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg;
    } catch {
      /* not JSON */
    }
    // 403 = the service account isn't a user on this property: retrying won't help.
    throw new IntegrationError("gsc", `Search Console ${res.status}: ${msg}`, res.status >= 500 || res.status === 429);
  }
  return schema.parse(text ? JSON.parse(text) : {});
}

const sitesSchema = z.object({
  siteEntry: z.array(z.object({ siteUrl: z.string(), permissionLevel: z.string() })).default([]),
});

export type GscSite = { siteUrl: string; permissionLevel: string };

const rowsSchema = z.object({
  rows: z
    .array(z.object({ keys: z.array(z.string()).default([]), clicks: z.number(), impressions: z.number(), ctr: z.number(), position: z.number() }))
    .default([]),
});

export type GscQuery = {
  startDate: string; // YYYY-MM-DD, in the property's timezone (Pacific time)
  endDate: string;
  dimensions?: ("query" | "page" | "date" | "country" | "device")[];
  rowLimit?: number;
  dataState?: "final" | "all";
};

export const gsc = {
  /** Properties the service account has been added to. Unverified entries are left out. */
  async listSites(): Promise<GscSite[]> {
    return callProvider("gsc", "sites.list", async (signal) => {
      const r = await gscFetch("/sites", { method: "GET" }, sitesSchema, signal);
      return r.siteEntry.filter((s) => s.permissionLevel !== "siteUnverifiedUser");
    });
  },

  /** searchAnalytics.query, paging through every row (25,000 per request) up to maxRows. */
  async query(siteUrl: string, q: GscQuery, maxRows = 50_000): Promise<GscRow[]> {
    const pageSize = Math.min(q.rowLimit ?? 25_000, 25_000);
    const out: GscRow[] = [];
    for (let startRow = 0; startRow < maxRows; startRow += pageSize) {
      const rows = await callProvider(
        "gsc",
        "searchAnalytics.query",
        async (signal) =>
          (
            await gscFetch(
              `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
              { method: "POST", body: JSON.stringify({ ...q, rowLimit: pageSize, startRow, type: "web", dataState: q.dataState ?? "final" }) },
              rowsSchema,
              signal,
            )
          ).rows,
        { timeoutMs: 60_000 },
      );
      out.push(...rows);
      if (rows.length < pageSize) break;
    }
    return out;
  },
};
