// Session cookie helpers. No server-only import: also used by proxy.ts.
import { EncryptJWT, jwtDecrypt } from "jose";

export const SESSION_COOKIE = "sa_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days, rolling
/** Re-issue the cookie when it is older than this, so active use keeps it alive. */
export const SESSION_REFRESH_AFTER = 60 * 60 * 24;

async function key(): Promise<Uint8Array> {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return new Uint8Array(digest);
}

export type Session = { sub: string; iat: number };

export async function createSessionToken(email: string): Promise<string> {
  return new EncryptJWT({ sub: email })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .encrypt(await key());
}

export async function readSessionToken(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtDecrypt(token, await key());
    if (typeof payload.sub !== "string" || typeof payload.iat !== "number") return null;
    if (payload.sub.toLowerCase() !== (process.env.ADMIN_EMAIL ?? "").toLowerCase()) return null;
    return { sub: payload.sub, iat: payload.iat };
  } catch {
    return null;
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_MAX_AGE,
};
