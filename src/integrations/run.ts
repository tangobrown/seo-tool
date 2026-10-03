import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { automationRuns, integrations } from "@/db/schema";

export class IntegrationError extends Error {
  constructor(
    public provider: string,
    message: string,
    public retryable = true,
  ) {
    super(message);
  }
}

/**
 * Every provider call goes through here: timeout, retries with backoff, and the provider's
 * health record (last_success_at / last_failure_at / last_error).
 */
export async function callProvider<T>(
  provider: string,
  op: string,
  fn: (signal: AbortSignal) => Promise<T>,
  opts: { timeoutMs?: number; retries?: number; updateHealth?: boolean } = {},
): Promise<T> {
  const { timeoutMs = 20_000, retries = 2, updateHealth = true } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`${provider}.${op} timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      const result = await fn(ctrl.signal);
      clearTimeout(timer);
      if (updateHealth) {
        await db
          .update(integrations)
          .set({ lastSuccessAt: new Date(), status: "connected" })
          .where(eq(integrations.provider, provider));
      }
      return result;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (e instanceof IntegrationError && !e.retryable) break;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
  if (updateHealth) {
    await db
      .update(integrations)
      .set({ lastFailureAt: new Date(), lastError: `${op}: ${message}`.slice(0, 2000), status: "error" })
      .where(eq(integrations.provider, provider));
  }
  throw lastErr instanceof Error ? lastErr : new Error(message);
}

export async function startRun(kind: string, clientId: string | null) {
  const [run] = await db.insert(automationRuns).values({ kind, clientId }).returning({ id: automationRuns.id });
  return run!.id;
}

export async function finishRun(id: string, status: "succeeded" | "failed", extra: { stats?: Record<string, unknown>; error?: string } = {}) {
  await db
    .update(automationRuns)
    .set({ status, finishedAt: new Date(), stats: extra.stats ?? null, error: extra.error ?? null })
    .where(eq(automationRuns.id, id));
}
