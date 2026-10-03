"use server";

import { verify } from "@node-rs/argon2";
import { and, eq, gte, sql } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { loginAttempts } from "@/db/schema";
import { audit } from "@/lib/audit";
import { safeEqual } from "@/lib/crypto";
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/session";

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;
const GENERIC_ERROR = "Incorrect email or password.";

const schema = z.object({ email: z.string().trim().max(320), password: z.string().max(1024) });

async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}

export type LoginState = { error?: string };

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = schema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { error: GENERIC_ERROR };
  const ip = await clientIp();

  const [{ failures } = { failures: 0 }] = await db
    .select({ failures: sql<number>`count(*)::int` })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.ip, ip),
        eq(loginAttempts.success, false),
        gte(loginAttempts.at, new Date(Date.now() - WINDOW_MS)),
      ),
    );
  if (failures >= MAX_FAILURES) {
    return { error: "Too many attempts. Try again in 15 minutes." };
  }

  const adminEmail = process.env.ADMIN_EMAIL ?? "";
  const hash = process.env.ADMIN_PASSWORD_HASH ?? "";
  const emailOk = safeEqual(parsed.data.email.toLowerCase(), adminEmail.toLowerCase());
  let passwordOk = false;
  try {
    // Always run the hash check, even with a wrong email, so timing doesn't leak which part was wrong.
    passwordOk = hash ? await verify(hash, parsed.data.password) : false;
  } catch {
    passwordOk = false;
  }
  const ok = emailOk && passwordOk && adminEmail !== "";

  await db.insert(loginAttempts).values({ ip, success: ok });
  if (!ok) return { error: GENERIC_ERROR };

  (await cookies()).set(SESSION_COOKIE, await createSessionToken(adminEmail), sessionCookieOptions);
  await audit({ actor: "operator", entityType: "session", event: "signed_in", meta: { ip } });
  redirect("/");
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
