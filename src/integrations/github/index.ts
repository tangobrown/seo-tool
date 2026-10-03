import "server-only";
import { createPrivateKey } from "node:crypto";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { z } from "zod";
import { db } from "@/db";
import { integrations } from "@/db/schema";
import { callProvider, IntegrationError } from "../run";
import type { CodeExecutionProvider, RepoInfo } from "../types";

const API = "https://api.github.com";

export function githubConfigured(): boolean {
  return !!(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY);
}

export function githubInstallUrl(): string | null {
  const slug = process.env.GITHUB_APP_SLUG;
  return slug ? `https://github.com/apps/${slug}/installations/new` : null;
}

async function appJwt(): Promise<string> {
  const pem = (process.env.GITHUB_APP_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
  const key = createPrivateKey(pem); // accepts PKCS#1 ("BEGIN RSA PRIVATE KEY") as GitHub issues it
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(String(process.env.GITHUB_APP_ID))
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 9 * 60)
    .sign(key);
}

async function gh<T>(path: string, init: RequestInit & { token: string; signal?: AbortSignal }, schema?: z.ZodType<T>): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${init.token}`,
      "User-Agent": "seo-autopilot",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (res.status === 404) throw new IntegrationError("github", `Not found: ${path}`, false);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new IntegrationError("github", `GitHub ${res.status} on ${path}: ${text.slice(0, 300)}`, res.status >= 500 || res.status === 429);
  }
  if (res.status === 204) return undefined as T;
  const json: unknown = await res.json();
  return schema ? schema.parse(json) : (json as T);
}

const installationSchema = z.array(z.object({ id: z.number(), account: z.object({ login: z.string() }).nullable() }));

async function installationId(signal: AbortSignal): Promise<number> {
  const [row] = await db.select().from(integrations).where(eq(integrations.provider, "github"));
  const stored = row?.config?.installationId;
  if (typeof stored === "number") return stored;
  const list = await gh("/app/installations", { token: await appJwt(), signal }, installationSchema);
  const first = list[0];
  if (!first) throw new IntegrationError("github", "The GitHub App isn’t installed on any account yet", false);
  await saveInstallation(first.id, first.account?.login ?? null);
  return first.id;
}

export async function saveInstallation(id: number, account: string | null) {
  await db
    .insert(integrations)
    .values({ provider: "github", status: "connected", config: { installationId: id, account }, lastSuccessAt: new Date() })
    .onConflictDoUpdate({
      target: integrations.provider,
      set: { status: "connected", config: { installationId: id, account }, lastSuccessAt: new Date(), lastError: null },
    });
}

let tokenCache: { token: string; expires: number } | null = null;

async function installationToken(signal: AbortSignal): Promise<string> {
  if (tokenCache && tokenCache.expires - Date.now() > 5 * 60_000) return tokenCache.token;
  const id = await installationId(signal);
  const out = await gh(
    `/app/installations/${id}/access_tokens`,
    { method: "POST", token: await appJwt(), signal },
    z.object({ token: z.string(), expires_at: z.string() }),
  );
  tokenCache = { token: out.token, expires: new Date(out.expires_at).getTime() };
  return out.token;
}

const repoSchema = z.object({ full_name: z.string(), default_branch: z.string(), private: z.boolean() });
const toRepo = (r: z.infer<typeof repoSchema>): RepoInfo => ({ fullName: r.full_name, defaultBranch: r.default_branch, private: r.private });

function b64(s: string) {
  return Buffer.from(s, "utf8").toString("base64");
}

export const github: CodeExecutionProvider = {
  async listRepos() {
    return callProvider("github", "listRepos", async (signal) => {
      const token = await installationToken(signal);
      const repos: RepoInfo[] = [];
      for (let page = 1; page <= 10; page++) {
        const out = await gh(
          `/installation/repositories?per_page=100&page=${page}`,
          { token, signal },
          z.object({ total_count: z.number(), repositories: z.array(repoSchema) }),
        );
        repos.push(...out.repositories.map(toRepo));
        if (repos.length >= out.total_count || out.repositories.length === 0) break;
      }
      return repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
    });
  },

  async getRepo(fullName) {
    return callProvider("github", "getRepo", async (signal) => {
      const token = await installationToken(signal);
      try {
        return toRepo(await gh(`/repos/${fullName}`, { token, signal }, repoSchema));
      } catch (e) {
        if (e instanceof IntegrationError && !e.retryable && e.message.startsWith("Not found")) return null;
        throw e;
      }
    });
  },

  async readFile(fullName, path, ref) {
    return callProvider("github", "readFile", async (signal) => {
      const token = await installationToken(signal);
      try {
        const out = await gh(
          `/repos/${fullName}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`,
          { token, signal },
          z.object({ content: z.string().optional(), encoding: z.string().optional() }),
        );
        return out.content ? Buffer.from(out.content, "base64").toString("utf8") : "";
      } catch (e) {
        if (e instanceof IntegrationError && e.message.startsWith("Not found")) return null;
        throw e;
      }
    });
  },

  /** Idempotent: reuses the branch and any open PR from an earlier attempt. */
  async openSetupPr({ fullName, baseBranch, branch, files, title, body }) {
    return callProvider(
      "github",
      "openSetupPr",
      async (signal) => {
        const token = await installationToken(signal);
        const [owner] = fullName.split("/");
        const existing = await gh(
          `/repos/${fullName}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
          { token, signal },
          z.array(z.object({ number: z.number(), html_url: z.string() })),
        );
        if (existing[0]) return { number: existing[0].number, url: existing[0].html_url, alreadyOpen: true };

        const base = await gh(
          `/repos/${fullName}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
          { token, signal },
          z.object({ object: z.object({ sha: z.string() }) }),
        );
        try {
          await gh(`/repos/${fullName}/git/refs`, {
            method: "POST",
            token,
            signal,
            body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base.object.sha }),
          });
        } catch (e) {
          // 422 = branch already exists from an earlier attempt; carry on and update files on it.
          if (!(e instanceof IntegrationError && e.message.includes("422"))) throw e;
        }
        for (const f of files) {
          let sha: string | undefined;
          try {
            const cur = await gh(
              `/repos/${fullName}/contents/${f.path}?ref=${encodeURIComponent(branch)}`,
              { token, signal },
              z.object({ sha: z.string(), content: z.string().optional() }),
            );
            if (cur.content && Buffer.from(cur.content, "base64").toString("utf8") === f.content) continue;
            sha = cur.sha;
          } catch (e) {
            if (!(e instanceof IntegrationError && e.message.startsWith("Not found"))) throw e;
          }
          await gh(`/repos/${fullName}/contents/${f.path}`, {
            method: "PUT",
            token,
            signal,
            body: JSON.stringify({ message: `chore: add ${f.path} (SEO Autopilot setup)`, content: b64(f.content), branch, ...(sha ? { sha } : {}) }),
          });
        }
        const pr = await gh(
          `/repos/${fullName}/pulls`,
          { method: "POST", token, signal, body: JSON.stringify({ title, body, head: branch, base: baseBranch }) },
          z.object({ number: z.number(), html_url: z.string() }),
        );
        return { number: pr.number, url: pr.html_url, alreadyOpen: false };
      },
      { timeoutMs: 60_000, retries: 1 },
    );
  },
};
