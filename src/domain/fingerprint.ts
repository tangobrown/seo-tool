import { createHash } from "node:crypto";

export function normaliseUrl(url: string | null | undefined): string {
  if (!url) return "";
  let u = url.trim().toLowerCase();
  u = u.replace(/^https?:\/\//, "").replace(/^www\./, "");
  u = u.replace(/[?#].*$/, "");
  const slash = u.indexOf("/");
  u = slash === -1 ? "/" : u.slice(slash);
  if (u.length > 1) u = u.replace(/\/+$/, "");
  return u;
}

export function normaliseQuery(q: string | null | undefined): string {
  return (q ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** §10.4: sha256(client_id | type | normalised target_url | normalised target_query | action_key) */
export function opportunityFingerprint(input: {
  clientId: string;
  type: string;
  targetUrl?: string | null;
  targetQuery?: string | null;
  actionKey: string;
}): string {
  return createHash("sha256")
    .update(
      [input.clientId, input.type, normaliseUrl(input.targetUrl), normaliseQuery(input.targetQuery), input.actionKey].join("|"),
    )
    .digest("hex");
}

export function evidenceHash(evidence: unknown): string {
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}
