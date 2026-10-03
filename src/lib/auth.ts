import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { readSessionToken, SESSION_COOKIE, type Session } from "./session";

export class UnauthorizedError extends Error {
  constructor() {
    super("Not signed in");
  }
}

/** Every server action and API route calls this. Never rely on proxy.ts alone. */
export async function requireSession(): Promise<Session> {
  const session = await readSessionToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) throw new UnauthorizedError();
  return session;
}

/** For server components: redirect to /login instead of throwing. */
export async function requirePageSession(): Promise<Session> {
  const session = await readSessionToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) redirect("/login");
  return session;
}
