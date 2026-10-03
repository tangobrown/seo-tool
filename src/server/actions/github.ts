"use server";

import { github, githubConfigured } from "@/integrations/github";
import { requireSession } from "@/lib/auth";
import type { ActionResult } from "./recommendations";

/** Repos the GitHub App can access. Returns ok:false when the App isn't set up, so the form falls back to a text field. */
export async function listGithubRepos(): Promise<ActionResult<{ repos: string[] }>> {
  await requireSession();
  if (!githubConfigured()) return { ok: false, error: "GitHub App not configured" };
  try {
    const repos = await github.listRepos();
    return { ok: true, repos: repos.map((r) => r.fullName) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "GitHub unavailable" };
  }
}
