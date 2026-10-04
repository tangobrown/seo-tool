import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clientConnections, clients, githubJobs, pages, type OnboardingStep } from "@/db/schema";
import { guessPageType } from "@/domain/html";
import { anthropicConfigured, llmJson } from "@/integrations/anthropic";
import { classifyPrompt, DISCOVERY_PROMPT_VERSION, DISCOVERY_SYSTEM, discoveryPrompt, discoverySchema, pageTypeSchema } from "@/integrations/anthropic/prompts/discovery";
import { github, githubConfigured } from "@/integrations/github";
import { CLIENT_REPO_TEMPLATES } from "@/integrations/github/templates.generated";
import { siteguru, siteguruConfigured } from "@/integrations/siteguru";
import { matchSite } from "@/integrations/siteguru/map";
import { notify, appLink } from "@/integrations/slack";
import { finishRun, startRun } from "@/integrations/run";
import { checkWebsite, crawlSite } from "@/integrations/website";
import { audit } from "@/lib/audit";
import { syncClientFromSiteguru } from "@/server/siteguru-sync";
import { raiseAttention, resolveAttention } from "@/lib/attention";
import { EVENTS, inngest } from "./client";
import { onJobFailure } from "./failure";

const data = z.object({ clientId: z.string().uuid() });

async function setStep(clientId: string, key: string, step: OnboardingStep) {
  const value = { ...step, at: new Date().toISOString() };
  await db
    .update(clients)
    .set({ onboarding: sql`${clients.onboarding} || ${JSON.stringify({ [key]: value })}::jsonb` })
    .where(eq(clients.id, clientId));
}

async function setConnection(clientId: string, provider: string, patch: Partial<typeof clientConnections.$inferInsert>) {
  await db
    .insert(clientConnections)
    .values({ clientId, provider, status: "pending", ...patch })
    .onConflictDoUpdate({ target: [clientConnections.clientId, clientConnections.provider], set: patch });
}

async function loadClient(clientId: string) {
  const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!c) throw new Error(`Client ${clientId} not found`);
  return c;
}

/** Runs a step body; records ok/failed on the client. A failure never stops later steps. */
async function recorded<T>(clientId: string, key: string, fn: () => Promise<{ status: OnboardingStep["status"]; message: string; data?: T }>) {
  await setStep(clientId, key, { status: "running" });
  try {
    const r = await fn();
    await setStep(clientId, key, { status: r.status, message: r.message });
    return r;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await setStep(clientId, key, { status: "failed", message: message.slice(0, 300) });
    return { status: "failed" as const, message, data: undefined };
  }
}

export const clientOnboard = inngest.createFunction(
  {
    id: "client-onboard",
    triggers: [{ event: EVENTS.clientOnboard }],
    concurrency: [{ key: "event.data.clientId", limit: 1 }],
    retries: 2,
    onFailure: async ({ event, error }) => {
      const d = data.safeParse(event.data.event.data);
      await onJobFailure("client.onboard", error, d.success ? d.data.clientId : null);
    },
  },
  async ({ event, step }) => {
    const { clientId } = data.parse(event.data);
    const runId = await step.run("start-run", () => startRun("client.onboard", clientId));

    // 2. Website
    const site = await step.run("website", () =>
      recorded(clientId, "website", async () => {
        const c = await loadClient(clientId);
        const r = await checkWebsite(c.websiteUrl);
        if (!r.ok) {
          await setConnection(clientId, "website", { status: "error", lastFailureAt: new Date(), lastError: r.error ?? `HTTP ${r.status}`, externalId: c.websiteUrl });
          await raiseAttention({ dedupeKey: `website_unreachable:${clientId}`, kind: "integration", clientId, title: `${c.domain} isn’t reachable`, detail: r.error ?? `The site returned HTTP ${r.status}.`, link: `/clients/${clientId}/settings` });
          return { status: "failed", message: r.error ?? `HTTP ${r.status}` };
        }
        const origin = new URL(r.finalUrl).origin;
        await db.update(clients).set({ domain: r.domain, websiteUrl: origin }).where(eq(clients.id, clientId));
        await setConnection(clientId, "website", { status: "connected", externalId: origin, lastSuccessAt: new Date(), lastError: null });
        await resolveAttention(`website_unreachable:${clientId}`);
        return { status: "ok", message: `Reachable at ${origin}`, data: { origin } };
      }),
    );

    // 3. GitHub: access, Next.js check, default branch, setup PR
    await step.run("github", () =>
      recorded(clientId, "github", async () => {
        const c = await loadClient(clientId);
        if (!c.githubRepo) return { status: "failed", message: "No repository set" };
        if (!githubConfigured()) {
          await setConnection(clientId, "github", { status: "not_connected", externalId: c.githubRepo, lastError: "GitHub App not configured" });
          await raiseAttention({ dedupeKey: "github_app_missing", kind: "integration", title: "Install the GitHub App", detail: "Set the GITHUB_APP_* variables and install the App so clients’ repos can be checked.", link: "/settings/integrations" });
          return { status: "skipped", message: "GitHub App not configured" };
        }
        const repo = await github.getRepo(c.githubRepo);
        if (!repo) {
          await setConnection(clientId, "github", { status: "not_found", externalId: c.githubRepo, lastFailureAt: new Date(), lastError: "The GitHub App can’t see this repository" });
          await raiseAttention({ dedupeKey: `github_repo:${clientId}`, kind: "integration", clientId, title: `GitHub App can’t access ${c.githubRepo}`, detail: "Add the repository to the App installation, then retry from the client’s Connections.", link: `/clients/${clientId}/settings` });
          return { status: "failed", message: "Repository not accessible" };
        }
        const pkg = await github.readFile(c.githubRepo, "package.json", repo.defaultBranch);
        let isNext = false;
        try {
          const j = JSON.parse(pkg ?? "{}") as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
          isNext = !!(j.dependencies?.next ?? j.devDependencies?.next);
        } catch {
          isNext = false;
        }
        await db.update(clients).set({ githubDefaultBranch: repo.defaultBranch }).where(eq(clients.id, clientId));
        if (!isNext) {
          await setConnection(clientId, "github", { status: "error", externalId: c.githubRepo, lastFailureAt: new Date(), lastError: "package.json doesn’t list next" });
          await raiseAttention({ dedupeKey: `github_repo:${clientId}`, kind: "integration", clientId, title: `${c.githubRepo} isn’t a Next.js site`, detail: "Only Next.js repositories are supported.", link: `/clients/${clientId}/settings` });
          return { status: "failed", message: "Not a Next.js repository" };
        }
        await setConnection(clientId, "github", { status: "connected", externalId: c.githubRepo, lastSuccessAt: new Date(), lastError: null });
        await resolveAttention(`github_repo:${clientId}`);
        return { status: "ok", message: `Next.js repo, default branch ${repo.defaultBranch}`, data: { defaultBranch: repo.defaultBranch } };
      }),
    );

    await step.run("setup-pr", () =>
      recorded(clientId, "setup_pr", async () => {
        const c = await loadClient(clientId);
        if (c.onboarding.github?.status !== "ok" || !c.githubRepo || !c.githubDefaultBranch) return { status: "skipped", message: "Waiting for GitHub" };
        const existing = await github.readFile(c.githubRepo, ".github/workflows/seo-autopilot.yml", c.githubDefaultBranch);
        if (existing !== null) return { status: "ok", message: "Workflow already installed" };
        const pr = await github.openSetupPr({
          fullName: c.githubRepo,
          baseBranch: c.githubDefaultBranch,
          branch: "seo-autopilot/setup",
          files: CLIENT_REPO_TEMPLATES,
          title: "Add SEO Autopilot workflow",
          body: [
            "This adds the SEO Autopilot GitHub Actions workflow and its QA scripts.",
            "",
            "- `.github/workflows/seo-autopilot.yml` runs Claude Code on approved SEO changes and opens one PR per batch.",
            "- `.seo-autopilot/qa.mjs` checks every batch before a PR is opened (routes, canonicals, titles, noindex, redirects, sitemap, diff size).",
            "",
            "Requires the organisation secrets `ANTHROPIC_API_KEY` and `SEO_AUTOPILOT_CALLBACK_SECRET`. See `.seo-autopilot/README.md`.",
            "",
            "Nothing runs until this is merged. Never auto-merged.",
          ].join("\n"),
        });
        await db
          .insert(githubJobs)
          .values({ clientId, kind: "setup", repo: c.githubRepo, branch: "seo-autopilot/setup", prNumber: pr.number, prUrl: pr.url, status: "pr_opened" })
          .onConflictDoNothing();
        await raiseAttention({
          dedupeKey: `setup_pr:${clientId}`,
          kind: "pr_review",
          clientId,
          title: `PR #${pr.number} ready — SEO Autopilot setup for ${c.name}`,
          detail: "Adds the workflow and QA script. Merge it before approving website changes.",
          link: pr.url,
        });
        return { status: "ok", message: `Setup PR #${pr.number} ${pr.alreadyOpen ? "already open" : "opened"}` };
      }),
    );

    // 4. SiteGuru match (§9.1): exact domain match against the sites the key can see.
    await step.run("siteguru", () =>
      recorded(clientId, "siteguru", async () => {
        const c = await loadClient(clientId);
        if (c.siteguruSiteId) return { status: "ok", message: `Linked to ${c.siteguruSiteId}` };
        if (!(await siteguruConfigured())) {
          await setConnection(clientId, "siteguru", { status: "not_connected", lastError: "No SiteGuru API key" });
          await raiseAttention({ dedupeKey: "siteguru_key_missing", kind: "integration", title: "Add your SiteGuru API key", detail: "Create a key on SiteGuru’s API access page and paste it in Settings → Integrations.", link: "/settings/integrations" });
          return { status: "skipped", message: "No SiteGuru API key yet" };
        }
        const site = matchSite(await siteguru.listSites(), c.domain);
        if (!site) {
          await setConnection(clientId, "siteguru", { status: "not_found", lastFailureAt: new Date(), lastError: `No SiteGuru site for ${c.domain}` });
          await raiseAttention({
            dedupeKey: `siteguru_missing:${clientId}`,
            kind: "integration",
            clientId,
            title: `Add ${c.domain} to SiteGuru`,
            detail: "No SiteGuru site matches this domain. Add it in SiteGuru, then choose it in the client’s Connections.",
            link: `/clients/${clientId}/settings`,
          });
          return { status: "failed", message: `No SiteGuru site matches ${c.domain}` };
        }
        await db.update(clients).set({ siteguruSiteId: site.domain }).where(eq(clients.id, clientId));
        await setConnection(clientId, "siteguru", { status: "connected", externalId: site.domain, lastError: null });
        await resolveAttention(`siteguru_missing:${clientId}`);
        const gsc = site.data_sources?.search_console?.connected;
        return { status: "ok", message: `Matched ${site.domain}${gsc === false ? " (Search Console not connected in SiteGuru)" : ""}` };
      }),
    );

    // 5. GBP match: Phase 6.
    await step.run("gbp", () =>
      recorded(clientId, "gbp", async () => {
        await setConnection(clientId, "gbp", { status: "not_connected" });
        return { status: "skipped", message: "Google Business Profile not connected yet (Phase 6)" };
      }),
    );

    // 6. Crawl + inventory
    const crawl = await step.run("crawl", () =>
      recorded(clientId, "crawl", async () => {
        if (site.status !== "ok") return { status: "skipped", message: "Website unreachable" };
        const c = await loadClient(clientId);
        const { pages: crawled, fromSitemap } = await crawlSite(c.websiteUrl, { maxPages: 300 });
        if (!crawled.length) return { status: "failed", message: "No pages could be fetched" };
        const linksIn = new Map<string, number>();
        for (const p of crawled) for (const l of p.links) {
          try {
            const path = new URL(l).pathname || "/";
            linksIn.set(path, (linksIn.get(path) ?? 0) + 1);
          } catch {
            /* ignore */
          }
        }
        const now = new Date();
        for (const p of crawled) {
          const values = {
            clientId,
            url: p.url,
            path: p.path,
            pageType: guessPageType(p.path),
            title: p.title,
            h1: p.h1,
            canonical: p.canonical,
            indexable: !p.noindex && p.status < 400,
            internalLinksIn: linksIn.get(p.path) ?? 0,
            internalLinksOut: p.links.length,
            lastCrawledAt: now,
          };
          await db.insert(pages).values(values).onConflictDoUpdate({ target: [pages.clientId, pages.url], set: values });
        }
        const home = crawled.find((p) => p.path === "/") ?? crawled[0]!;
        return {
          status: "ok",
          message: `${crawled.length} pages crawled${fromSitemap ? " (from sitemap)" : ""}`,
          data: { homepageText: home.text.slice(0, 8000) },
        };
      }),
    );

    // 6b + 7. LLM classification and service/location discovery
    await step.run("discovery", () =>
      recorded(clientId, "discovery", async () => {
        if (crawl.status !== "ok") return { status: "skipped", message: "No page inventory" };
        if (!(await anthropicConfigured())) {
          await raiseAttention({ dedupeKey: "anthropic_missing", kind: "integration", title: "Add the Anthropic API key", detail: "Discovery and classification need an Anthropic API key. Paste it in Settings → Integrations.", link: "/settings/integrations" });
          return { status: "failed", message: "No Anthropic API key — add services and locations by hand" };
        }
        const c = await loadClient(clientId);
        const inv = await db.select({ path: pages.path, title: pages.title, h1: pages.h1 }).from(pages).where(eq(pages.clientId, clientId));

        for (let i = 0; i < inv.length; i += 100) {
          const chunk = inv.slice(i, i + 100);
          const out = await llmJson({ schema: pageTypeSchema, schemaName: "classifyPages", system: DISCOVERY_SYSTEM, prompt: classifyPrompt(chunk) });
          for (const p of out.pages) {
            if (!chunk.some((x) => x.path === p.path)) continue; // ignore anything not in the input
            await db
              .update(pages)
              .set({ pageType: p.page_type, service: p.service, location: p.location, commercialIntent: p.commercial_intent })
              .where(and(eq(pages.clientId, clientId), eq(pages.path, p.path)));
          }
        }

        const found = await llmJson({
          schema: discoverySchema,
          schemaName: "discoverServices",
          system: DISCOVERY_SYSTEM,
          prompt: discoveryPrompt({ domain: c.domain, homepageText: crawl.data?.homepageText ?? "", pages: inv }),
        });
        const uniq = (xs: string[]) => [...new Map(xs.map((x) => x.trim()).filter(Boolean).map((x) => [x.toLowerCase(), x])).values()].slice(0, 15);
        const services = uniq(found.services);
        const locations = uniq(found.locations);
        await db
          .update(clients)
          .set({
            services: c.services.length ? c.services : services,
            locations: c.locations.length ? c.locations : locations,
            industry: c.industry || found.industry,
            primaryLocation: c.primaryLocation || found.primary_location,
          })
          .where(eq(clients.id, clientId));
        await audit({ actor: "system", clientId, entityType: "client", entityId: clientId, event: "client.discovered", after: { services, locations, promptVersion: DISCOVERY_PROMPT_VERSION } });
        return { status: "ok", message: `${services.length} services and ${locations.length} locations found` };
      }),
    );

    // 8. First SiteGuru sync.
    await step.run("siteguru-sync", () =>
      recorded(clientId, "siteguru_sync", async () => {
        const out = await syncClientFromSiteguru(clientId);
        return { status: out.status === "synced" ? "ok" : "skipped", message: out.message };
      }),
    );

    // 9. Awaiting confirmation
    await step.run("await-confirmation", async () => {
      const c = await loadClient(clientId);
      if (c.status !== "onboarding") return; // e.g. retry after activation
      await db.update(clients).set({ status: "awaiting_confirmation" }).where(and(eq(clients.id, clientId), eq(clients.status, "onboarding")));
      await raiseAttention({
        dedupeKey: `confirm_client:${clientId}`,
        kind: "confirm_client",
        clientId,
        title: `Confirm services and locations for ${c.name}`,
        detail: `We found ${c.services.length} services and ${c.locations.length} locations on the website.`,
        link: `/clients/${clientId}/settings`,
      });
      await audit({ actor: "system", clientId, entityType: "client", entityId: clientId, event: "client.awaiting_confirmation" });
      await notify("failures", `${c.name} is ready to confirm: ${appLink(`/clients/${clientId}/settings`, "Review")}`);
    });

    await step.run("finish-run", () => finishRun(runId, "succeeded"));
    return { ok: true };
  },
);
