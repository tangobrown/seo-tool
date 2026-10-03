// Recreates the design mock's data so the UI can be reviewed before any integration exists.
// Usage: pnpm db:seed   (wipes all app data first)
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { evidenceHash, opportunityFingerprint } from "../domain/fingerprint";
import { reportEmailHtml, reportEmailText } from "../domain/report-email";
import * as s from "./schema";

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const pool = new pg.Pool({ connectionString: url });
const db = drizzle({ client: pool, schema: s });

const SIGNOFF = "Thanks,\nThe SEO Autopilot team";

type MockClient = {
  key: string;
  name: string;
  domain: string;
  tier: "Starter" | "Growth" | "Pro";
  contact: string;
  email: string;
  industry: string;
  location: string;
  base: number;
  seed: number;
  pending: number;
  service: string;
  oldPost: string;
  kws: string[];
  pages: string[];
  posts: string[];
  services: string[];
  locations: string[];
};

// The mock's five clients, localised to UK towns (the agency is UK-based).
const CLIENTS: MockClient[] = [
  {
    key: "hp", name: "Harbour & Pine Dental", domain: "harbourpinedental.co.uk", tier: "Growth", contact: "Dr. Maya Chen",
    email: "maya@harbourpinedental.co.uk", industry: "Dental clinic", location: "Bristol", base: 2600, seed: 1, pending: 6,
    service: "Teeth whitening", oldPost: "How often should you see a dentist?",
    kws: ["dentist bristol", "teeth whitening bristol", "emergency dentist bristol", "invisalign bristol", "children's dentist"],
    pages: ["/", "/services/teeth-whitening", "/blog/dental-anxiety-tips", "/services/invisalign", "/contact"],
    posts: ["Is teeth whitening safe? What Bristol patients should know", "5 signs you need an emergency dentist"],
    services: ["Teeth whitening", "Invisalign", "Emergency dentistry", "Children's dentistry", "Dental implants"],
    locations: ["Bristol", "Clifton", "Bath"],
  },
  {
    key: "nr", name: "Northfield Roofing", domain: "northfieldroofing.co.uk", tier: "Pro", contact: "Dan Okoye",
    email: "dan@northfieldroofing.co.uk", industry: "Home services", location: "Leeds", base: 4100, seed: 2, pending: 4,
    service: "Roof repair", oldPost: "Slate vs concrete tiles",
    kws: ["roofer leeds", "roof repair leeds", "storm damage roof", "roof replacement cost", "guttering leeds"],
    pages: ["/", "/roof-repair", "/storm-damage", "/blog/roof-replacement-cost", "/gallery"],
    posts: ["What to do after a storm damages your roof", "How long does a roof replacement take?"],
    services: ["Roof repair", "Roof replacement", "Storm damage", "Guttering", "Flat roofs"],
    locations: ["Leeds", "Harrogate", "Wakefield", "Bradford"],
  },
  {
    key: "ly", name: "Lumen Yoga Studio", domain: "lumenyoga.co.uk", tier: "Starter", contact: "Priya Raman",
    email: "priya@lumenyoga.co.uk", industry: "Fitness & wellness", location: "Brighton", base: 900, seed: 3, pending: 0,
    service: "Beginner classes", oldPost: "What to bring to your first class",
    kws: ["yoga brighton", "hot yoga brighton", "beginner yoga classes", "yoga teacher training", "pregnancy yoga brighton"],
    pages: ["/", "/schedule", "/beginners", "/teacher-training", "/blog/hot-yoga-benefits"],
    posts: ["Hot yoga vs vinyasa: which is right for you?", "A beginner’s first week at Lumen"],
    services: ["Beginner classes", "Hot yoga", "Teacher training", "Pregnancy yoga"],
    locations: ["Brighton", "Hove"],
  },
  {
    key: "ol", name: "Okafor Legal", domain: "okaforlegal.co.uk", tier: "Growth", contact: "Chidi Okafor",
    email: "chidi@okaforlegal.co.uk", industry: "Immigration law", location: "Manchester", base: 1700, seed: 4, pending: 3,
    service: "Spouse visa applications", oldPost: "Skilled Worker visa explained",
    kws: ["immigration solicitor manchester", "spouse visa solicitor", "british citizenship help", "skilled worker visa lawyer", "family visa solicitor"],
    pages: ["/", "/spouse-visas", "/citizenship", "/blog/skilled-worker-visa", "/consultation"],
    posts: ["How long does a spouse visa take in 2026?", "Indefinite leave to remain: a step-by-step guide"],
    services: ["Spouse visas", "British citizenship", "Skilled Worker visas", "Indefinite leave to remain"],
    locations: ["Manchester", "Salford", "Stockport"],
  },
  {
    key: "bp", name: "Brightside Pet Supplies", domain: "brightsidepets.co.uk", tier: "Pro", contact: "Tom Avery",
    email: "tom@brightsidepets.co.uk", industry: "E-commerce", location: "United Kingdom", base: 6800, seed: 5, pending: 5,
    service: "Grain-free dog food", oldPost: "Best toys for heavy chewers",
    kws: ["grain free dog food", "natural cat litter", "dog chew toys", "pet supplies online", "senior dog food"],
    pages: ["/", "/collections/dog-food", "/collections/cat-litter", "/products/chew-bone-xl", "/blog/senior-dog-diet"],
    posts: ["Choosing food for a senior dog", "Is natural cat litter worth it?"],
    services: ["Dog food", "Cat litter", "Dog toys", "Pet accessories"],
    locations: ["United Kingdom"],
  },
];

type Rec = {
  category: (typeof s.category.enumValues)[number];
  impact: "high" | "medium" | "low";
  type: string;
  title: string;
  description: string;
  url: string;
  exec: (typeof s.executionType.enumValues)[number];
  risk: "low" | "medium" | "high";
  why: string;
  proposed: string;
  benefit: string;
  evidence: s.EvidenceItem[];
  blog?: boolean;
};

function recPool(c: MockClient): Rec[] {
  const kw = c.kws[1] ?? "";
  return [
    {
      category: "technical", impact: "high", type: "technical_issue", title: "Fix 14 internal links pointing at 404 pages",
      description: "Broken internal links are sending visitors and crawlers to dead pages. We’ll point each link at the closest live page.",
      url: "/services/*", exec: "github_pr", risk: "low",
      why: "Crawlers waste time on dead ends and visitors leave when a link goes nowhere.",
      proposed: "Update 14 internal links in page components to point at live URLs. No redirects are added.",
      benefit: "Cleaner crawl and fewer lost visitors.",
      evidence: [{ source: "siteguru", metric: "broken internal links", value: 14, note: "found on 6 pages" }],
    },
    {
      category: "content", impact: "high", type: "blog_content", title: `Publish blog post targeting “${kw}”`,
      description: `This keyword gets an estimated 1,900 searches a month and ${c.domain} isn’t ranking yet. A 1,500-word guide is drafted and ready for review.`,
      url: "/blog/new", exec: "github_pr", risk: "low", blog: true,
      why: `People are searching for “${kw}” and the site has no page answering it.`,
      proposed: "Add a new blog post at /blog with the drafted guide, linked from the relevant service page.",
      benefit: "A new entry point from search for a relevant, commercial query.",
      evidence: [
        { source: "siteguru", metric: "monthly searches", value: "1,900", note: kw },
        { source: "serp", metric: "client position", value: "not in top 100", note: kw },
      ],
    },
    {
      category: "on_page", impact: "medium", type: "metadata", title: "Rewrite title tags on 6 key pages",
      description: "Current titles are truncated in search results and miss the primary keyword. Proposed titles stay under 60 characters.",
      url: c.pages[1] ?? "/", exec: "github_pr", risk: "low",
      why: "Titles over 60 characters are cut off in results, hiding the keyword.",
      proposed: "Update the Metadata API title on 6 pages to under 60 characters, keyword first.",
      benefit: "Better click-through rate from existing impressions.",
      evidence: [
        { source: "siteguru", metric: "titles too long", value: 6 },
        { source: "siteguru", metric: "impressions/month on these pages", value: "4,200", period: "last 30 days" },
      ],
    },
    {
      category: "technical", impact: "medium", type: "technical_issue", title: "Compress 23 oversized images",
      description: "Mobile load time is 4.1s. Converting images to WebP should bring it under 2.5s.",
      url: "/", exec: "github_pr", risk: "low",
      why: "Large images slow mobile pages, which hurts rankings and conversions.",
      proposed: "Convert 23 images to WebP and serve them with next/image.",
      benefit: "Faster mobile pages.",
      evidence: [{ source: "siteguru", metric: "mobile load time", value: "4.1s" }, { source: "crawl", metric: "images over 300 KB", value: 23 }],
    },
    {
      category: "links", impact: "medium", type: "link_opportunity", title: "Reclaim 3 unlinked brand mentions",
      description: `Three local publications mention ${c.name} without linking. We’ll draft short outreach emails asking for a link.`,
      url: "external", exec: "manual_action", risk: "low",
      why: "Mentions without links pass no authority.",
      proposed: "Send three short outreach emails (drafts provided).",
      benefit: "Up to three new relevant backlinks.",
      evidence: [{ source: "siteguru", metric: "unlinked mentions", value: 3 }],
    },
    {
      category: "content", impact: "medium", type: "existing_page_optimisation", title: `Refresh “${c.oldPost}”`,
      description: "Traffic to this post is down 38% since spring. We’ll update outdated sections and add a FAQ.",
      url: c.pages[2] ?? "/", exec: "github_pr", risk: "low",
      why: "The post is losing clicks to fresher competitor content.",
      proposed: "Update outdated sections and add a short FAQ block with FAQPage schema.",
      benefit: "Recover lost traffic on an established page.",
      evidence: [{ source: "siteguru", metric: "clicks change", value: "-38%", period: "since April" }],
    },
    {
      category: "on_page", impact: "medium", type: "internal_linking", title: `Add internal links to the ${c.service.toLowerCase()} page`,
      description: "Only two pages link here. Adding links from five related blog posts should help it rank.",
      url: c.pages[1] ?? "/", exec: "github_pr", risk: "low",
      why: "Pages with few internal links are harder for search engines to judge as important.",
      proposed: "Add contextual links from five related blog posts.",
      benefit: "Stronger ranking signals for a priority service page.",
      evidence: [
        { source: "crawl", metric: "internal links in", value: 2 },
        { source: "siteguru", metric: "position", value: 6, note: c.kws[1] },
      ],
    },
    {
      category: "on_page", impact: "low", type: "schema", title: "Add FAQ schema to the contact page",
      description: "Structured data can show your FAQs directly in search results.",
      url: c.pages[4] ?? "/contact", exec: "github_pr", risk: "low",
      why: "The page already has FAQs but no structured data.",
      proposed: "Add FAQPage JSON-LD for the existing questions.",
      benefit: "Eligibility for rich results.",
      evidence: [{ source: "siteguru", metric: "structured data", value: "missing" }],
    },
    {
      category: "technical", impact: "low", type: "technical_issue", title: "Add missing alt text to 41 images",
      description: "Helps accessibility and image search. Descriptions are generated and ready to apply.",
      url: "/*", exec: "github_pr", risk: "low",
      why: "Images without alt text are invisible to screen readers and image search.",
      proposed: "Add descriptive alt text to 41 images.",
      benefit: "Accessibility and image search visibility.",
      evidence: [{ source: "siteguru", metric: "images missing alt", value: 41 }],
    },
    {
      category: "technical", impact: "high", type: "technical_issue", title: "Redirect www to non-www",
      description: "Both versions of the homepage are indexed, splitting ranking signals between them.",
      url: "/", exec: "manual_action", risk: "medium",
      why: "Duplicate hosts split ranking signals.",
      proposed: "Add a host redirect in Vercel project settings (redirects are always manual).",
      benefit: "One canonical host for all ranking signals.",
      evidence: [{ source: "crawl", metric: "indexed hosts", value: 2, note: "www and non-www both return 200" }],
    },
  ];
}

const CYCLE = ["approved", "approved", "deferred", "approved", "declined"] as const;

function rnd(seed: number, i: number) {
  const x = Math.sin(seed * 97.13 + i * 12.7) * 43758.5453;
  return x - Math.floor(x);
}

function monthlyClicks(c: MockClient): number[] {
  const m: number[] = [];
  let v = c.base * 0.7;
  for (let i = 0; i < 12; i++) {
    v *= 1 + 0.03 + (rnd(c.seed, i) - 0.45) * 0.12;
    m.push(Math.round(v));
  }
  return m;
}

function monthStart(year: number, month0: number) {
  return new Date(Date.UTC(year, month0, 1));
}

function periodKey(d: Date) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const fmt = (n: number) => new Intl.NumberFormat("en-GB").format(Math.round(n));

async function main() {
  const now = new Date();
  console.log("Wiping data…");
  await db.execute(sql`
    truncate table opportunity_results, login_attempts, audit_log, webhook_events, automation_runs, attention_items,
      monthly_reports, blog_commitments, serp_snapshots, metric_snapshots, gbp_changes, github_jobs, executions,
      batches, opportunities, pages, oauth_tokens, client_connections, integrations, clients, tiers, workspace cascade`);
  await db.execute(sql`alter sequence client_ref_seq restart with 1`);

  await db.insert(s.workspace).values({
    id: 1,
    name: "SEO Autopilot",
    senderName: "SEO Autopilot",
    replyTo: "hello@example.co.uk",
    signoff: SIGNOFF,
  });

  const tierRows = await db
    .insert(s.tiers)
    .values([
      { name: "Starter", postsPerMonth: 2, scanFrequency: "monthly", pricePence: 45000, sortOrder: 1 },
      { name: "Growth", postsPerMonth: 4, scanFrequency: "fortnightly", pricePence: 90000, sortOrder: 2 },
      { name: "Pro", postsPerMonth: 8, scanFrequency: "weekly", pricePence: 180000, sortOrder: 3 },
    ])
    .returning();
  const tierByName = Object.fromEntries(tierRows.map((t) => [t.name, t]));

  await db.insert(s.integrations).values([
    { provider: "siteguru", status: "connected", lastSuccessAt: new Date(now.getTime() - 12 * 60_000) },
    { provider: "github", status: "not_connected" },
    { provider: "gbp", status: "not_connected" },
    { provider: "serp", status: "not_connected" },
    { provider: "anthropic", status: "not_connected" },
    { provider: "slack", status: "not_connected" },
  ]);

  const thisMonth = monthStart(now.getUTCFullYear(), now.getUTCMonth());
  const lastPeriod = periodKey(monthStart(now.getUTCFullYear(), now.getUTCMonth() - 1));

  for (const c of CLIENTS) {
    const tier = tierByName[c.tier]!;
    const [client] = await db
      .insert(s.clients)
      .values({
        name: c.name,
        domain: c.domain,
        websiteUrl: `https://${c.domain}`,
        status: "active",
        tierId: tier.id,
        contactName: c.contact,
        contactEmail: c.email,
        industry: c.industry,
        primaryLocation: c.location,
        keywords: c.kws,
        services: c.services,
        priorityServices: c.services.slice(0, 2),
        locations: c.locations,
        brandTone: "Friendly, plain English, no jargon",
        autoApproveLowImpact: true,
        reviewBlogPosts: true,
        githubRepo: `example-agency/${c.domain.split(".")[0]}`,
        githubDefaultBranch: "main",
        siteguruSiteId: c.domain,
        createdAt: new Date(now.getTime() - 200 * 86400_000),
      })
      .returning();
    if (!client) throw new Error("insert failed");

    await db.insert(s.clientConnections).values([
      { clientId: client.id, provider: "website", status: "connected", externalId: `https://${c.domain}`, lastSuccessAt: now },
      { clientId: client.id, provider: "github", status: "connected", externalId: client.githubRepo, lastSuccessAt: now },
      { clientId: client.id, provider: "siteguru", status: "connected", externalId: c.domain, lastSuccessAt: new Date(now.getTime() - 12 * 60_000) },
      { clientId: client.id, provider: "gbp", status: "not_connected" },
    ]);

    // Recommendations, rotated per client as in the mock.
    const pool = recPool(c);
    const k = c.seed % pool.length;
    const rot = pool.slice(k).concat(pool.slice(0, k));
    const decidedBase = new Date(now.getTime() - 3 * 86400_000);
    const approved: { id: string; exec: Rec["exec"] }[] = [];
    for (const [i, r] of rot.entries()) {
      const pending = i < c.pending;
      const decision = pending ? null : CYCLE[i % 5]!;
      const status = pending ? "recommended" : decision === "approved" ? "approved" : decision!;
      const actionKey = r.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const scores = { high: 86, medium: 72, low: 66 } as const;
      const [opp] = await db
        .insert(s.opportunities)
        .values({
          clientId: client.id,
          fingerprint: opportunityFingerprint({ clientId: client.id, type: r.type, targetUrl: r.url, actionKey }),
          type: r.type,
          category: r.category,
          title: r.title,
          description: r.description,
          why: r.why,
          proposedAction: r.proposed,
          expectedBenefit: r.benefit,
          targetUrl: r.url,
          targetQuery: r.blog ? (c.kws[1] ?? null) : null,
          evidence: r.evidence,
          evidenceHash: evidenceHash(r.evidence),
          priorityScore: scores[r.impact] - i * 0.1,
          impactLabel: r.impact,
          riskLabel: r.risk,
          executionType: r.exec,
          status,
          isBlogCommitment: !!r.blog,
          payload: r.blog
            ? {
                draft: {
                  title: c.posts[0],
                  body:
                    `${c.posts[0]}\n\nThis is a seeded placeholder draft. Real drafts are generated from evidence in Phase 8.\n\n` +
                    `It only mentions ${c.services.slice(0, 2).join(" and ")} in ${c.locations[0]}.`,
                },
              }
            : null,
          deferredUntil: decision === "deferred" ? new Date(now.getTime() + 25 * 86400_000) : null,
          decidedAt: decision ? new Date(decidedBase.getTime() + i * 60_000) : null,
          decidedBy: decision ? "operator" : null,
          timesRecommended: 1,
        })
        .returning();
      if (decision === "approved" && opp) approved.push({ id: opp.id, exec: r.exec });
    }

    // One completed batch with mixed execution statuses so the Actioned tab shows the range.
    const approvedIds = approved.map((a) => a.id);
    if (approvedIds.length) {
      const startsAt = new Date(decidedBase.getTime() + 2 * 60_000);
      const [batch] = await db
        .insert(s.batches)
        .values({
          clientId: client.id,
          idempotencyKey: `seed-${client.id}`,
          status: "awaiting_merge",
          startsAt,
          startedAt: startsAt,
          createdAt: decidedBase,
        })
        .returning();
      const prNumber = 40 + c.seed;
      const prUrl = `https://github.com/${client.githubRepo}/pull/${prNumber}`;
      const statuses = ["live", "pr_ready", "failed", "live"] as const;
      for (const [i, { id: oid, exec }] of approved.entries()) {
        const st = exec === "manual_action" ? "action_needed" : statuses[i % statuses.length]!;
        await db.insert(s.executions).values({
          batchId: batch!.id,
          opportunityId: oid,
          executionType: exec,
          status: st,
          idempotencyKey: `seed-${oid}`,
          error: st === "failed" ? "QA failed: canonical missing on " + (c.pages[1] ?? "/") : null,
          result: st === "failed" ? null : { prNumber, prUrl },
          startedAt: startsAt,
          finishedAt: st === "live" ? now : null,
        });
      }
      await db.update(s.opportunities).set({ batchId: batch!.id }).where(sql`${s.opportunities.id} in ${approvedIds}`);
      await db.insert(s.githubJobs).values({
        batchId: batch!.id,
        clientId: client.id,
        repo: client.githubRepo!,
        branch: `seo-autopilot/batch-${batch!.id.slice(0, 8)}`,
        prNumber,
        prUrl,
        status: "pr_opened",
      });
      if (c.key === "hp" || c.key === "nr") {
        await db.insert(s.attentionItems).values({
          clientId: client.id,
          kind: "pr_review",
          title: `PR #${prNumber} ready — ${approvedIds.length} changes for ${c.name}`,
          detail: "QA passed. Review and merge on GitHub.",
          link: prUrl,
          dedupeKey: `pr_review:${batch!.id}`,
        });
      }
      if (c.key === "nr") {
        await db.insert(s.attentionItems).values({
          clientId: client.id,
          kind: "failed",
          title: `Batch failed at QA: canonical missing on ${c.pages[1]}`,
          detail: "One change failed SEO QA. No PR was opened for it.",
          link: `/clients/${client.id}/actioned`,
          dedupeKey: `failed:${batch!.id}`,
        });
      }
    }

    // Metrics: 12 monthly snapshots plus the rolling 30-day snapshot.
    const clicks = monthlyClicks(c);
    for (let i = 0; i < 12; i++) {
      const start = monthStart(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() - 12 + i);
      const end = monthStart(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() - 11 + i);
      await db.insert(s.metricSnapshots).values({
        clientId: client.id,
        source: "siteguru",
        kind: "month",
        periodStart: start,
        periodEnd: end,
        metrics: { clicks: clicks[i]!, impressions: clicks[i]! * (34 + c.seed * 3) },
        capturedAt: end,
      });
    }
    const cur = clicks[11]!;
    const prv = clicks[10]!;
    const r = (i: number) => rnd(c.seed, 50 + i);
    const impr = cur * (34 + c.seed * 3);
    const pimpr = prv * (33 + c.seed * 3);
    const pos = Math.round((9 + r(1) * 5) * 10) / 10;
    await db.insert(s.metricSnapshots).values({
      clientId: client.id,
      source: "siteguru",
      kind: "rolling30",
      periodStart: new Date(now.getTime() - 30 * 86400_000),
      periodEnd: now,
      capturedAt: new Date(now.getTime() - 12 * 60_000),
      metrics: {
        clicks: cur,
        impressions: impr,
        avgPosition: pos,
        ctr: Math.round((cur / impr) * 1000) / 10,
        prev: { clicks: prv, impressions: pimpr, avgPosition: Math.round((pos + 0.6) * 10) / 10, ctr: Math.round((prv / pimpr) * 1000) / 10 },
        topPages: c.pages.map((p, i) => ({ path: p, clicks: Math.round(cur * [0.34, 0.18, 0.12, 0.08, 0.05][i]!) })),
        topKeywords: c.kws.map((kw, i) => ({
          keyword: kw,
          position: Math.max(1, Math.round(2 + i * 2.4 + r(20 + i) * 3)),
          change: Math.round((r(10 + i) - 0.3) * 6),
        })),
      },
    });

    // Three monthly reports, newest unread.
    const tierPosts = tier.postsPerMonth;
    for (let back = 1; back <= 3; back++) {
      const mi = 12 - back; // index into clicks (11 = last full month)
      const pStart = monthStart(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() - back);
      const period = periodKey(pStart);
      const label = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(pStart);
      const prevLabel = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(
        monthStart(pStart.getUTCFullYear(), pStart.getUTCMonth() - 1),
      );
      const mc = clicks[mi]!;
      const mp = clicks[mi - 1]!;
      const pct = Math.round((mc / mp - 1) * 100);
      const rr = (i: number) => rnd(c.seed + mi, i);
      const fixes = 6 + Math.floor(rr(5) * 14);
      const titles = 3 + Math.floor(rr(6) * 6);
      const imgs = 10 + Math.floor(rr(7) * 30);
      const mpos = (9 + rr(1) * 5).toFixed(1);
      const ppos = (+mpos + 0.4 + rr(2)).toFixed(1);
      const from = 6 + Math.floor(rr(3) * 6);
      const to = Math.max(2, from - 2 - Math.floor(rr(4) * 3));
      const summary = `In ${label.split(" ")[0]}, organic search brought ${fmt(mc)} visitors to ${c.domain}, ${pct >= 0 ? "up" : "down"} ${Math.abs(pct)}% on ${prevLabel}. We published ${tierPosts} new blog posts and completed ${fixes} technical fixes across the site.`;
      const sections: s.ReportSection[] = [
        {
          title: "What we did",
          items: [
            `Published ${tierPosts} blog posts, including “${c.posts[0]}” and “${c.posts[1]}”`,
            `Fixed ${fixes} technical issues, including broken links`,
            `Rewrote title tags and meta descriptions on ${titles} pages`,
            `Compressed ${imgs} images to speed up mobile load times`,
          ],
        },
        {
          title: "How it performed",
          items: [
            `Organic clicks: ${fmt(mc)} (${pct >= 0 ? "+" : ""}${pct}% vs ${prevLabel})`,
            `Search impressions: ${fmt(mc * (34 + c.seed * 3))}`,
            `Average position: ${mpos} (improved from ${ppos})`,
            `“${c.kws[0]}” moved from position ${from} to ${to}`,
          ],
        },
        {
          title: "Next month",
          items: [
            `Publish ${tierPosts} posts targeting “${c.kws[1]}” and “${c.kws[2]}”`,
            `Improve internal linking to the ${c.service.toLowerCase()} page`,
          ],
        },
      ];
      const emailInput = { contactName: c.contact, periodLabel: label, summary, sections, signoff: SIGNOFF };
      const generatedAt = new Date(monthStart(pStart.getUTCFullYear(), pStart.getUTCMonth() + 1).getTime() + 6 * 3600_000);
      await db.insert(s.monthlyReports).values({
        clientId: client.id,
        period,
        status: back === 1 ? "generated" : "sent",
        generatedAt,
        readAt: back === 1 ? null : generatedAt,
        sentAt: back === 1 ? null : new Date(generatedAt.getTime() + 86400_000),
        summary,
        sections,
        emailText: reportEmailText(emailInput),
        emailHtml: reportEmailHtml(emailInput),
      });
      if (back === 1) {
        await db.insert(s.attentionItems).values({
          clientId: client.id,
          kind: "report_ready",
          title: `${label.split(" ")[0]} report ready for ${c.name}`,
          detail: "Review it, copy it into an email and mark it sent.",
          link: `/clients/${client.id}/reports`,
          dedupeKey: `report_ready:${client.id}:${period}`,
        });
      }
    }
    void lastPeriod;

    // Blog commitment for this month.
    await db.insert(s.blogCommitments).values({
      clientId: client.id,
      period: periodKey(thisMonth),
      committed: tierPosts,
      planned: tierPosts,
      drafted: Math.min(tierPosts, 1),
      approved: c.key === "nr" ? 1 : Math.min(tierPosts, 1),
      published: c.key === "ly" ? 1 : 0,
    });
  }

  // A newly added client awaiting confirmation (exercises the "Confirm details" flow).
  const [exeter] = await db
    .insert(s.clients)
    .values({
      name: "Exeter Heating",
      domain: "exeterheating.co.uk",
      websiteUrl: "https://exeterheating.co.uk",
      status: "awaiting_confirmation",
      tierId: tierByName.Growth!.id,
      contactName: "Sam Hughes",
      contactEmail: "sam@exeterheating.co.uk",
      industry: "Heating engineers",
      primaryLocation: "Exeter",
      services: ["Boiler repair", "Boiler installation", "Boiler servicing", "Central heating", "Power flushing", "Landlord gas safety certificates"],
      locations: ["Exeter", "Exmouth", "Crediton", "Topsham"],
      githubRepo: "example-agency/exeter-heating",
      githubDefaultBranch: "main",
      onboarding: {
        website: { status: "ok", message: "Reachable at https://exeterheating.co.uk" },
        github: { status: "ok", message: "Next.js repo, default branch main" },
        siteguru: { status: "failed", message: "No SiteGuru site matches exeterheating.co.uk" },
        gbp: { status: "skipped", message: "Google Business Profile not connected" },
        crawl: { status: "ok", message: "42 pages crawled" },
        discovery: { status: "ok", message: "6 services and 4 locations found" },
      },
    })
    .returning();
  await db.insert(s.clientConnections).values([
    { clientId: exeter!.id, provider: "website", status: "connected", externalId: "https://exeterheating.co.uk", lastSuccessAt: now },
    { clientId: exeter!.id, provider: "github", status: "connected", externalId: "example-agency/exeter-heating", lastSuccessAt: now },
    { clientId: exeter!.id, provider: "siteguru", status: "not_found", lastFailureAt: now, lastError: "No matching site" },
    { clientId: exeter!.id, provider: "gbp", status: "not_connected" },
  ]);
  await db.insert(s.attentionItems).values([
    {
      clientId: exeter!.id,
      kind: "confirm_client",
      title: "Confirm services and locations for Exeter Heating",
      detail: "We found 6 services and 4 locations on the website.",
      link: `/clients/${exeter!.id}/settings`,
      dedupeKey: `confirm_client:${exeter!.id}`,
    },
    {
      clientId: exeter!.id,
      kind: "integration",
      title: "Add exeterheating.co.uk to SiteGuru",
      detail: "No SiteGuru site matches this domain. Add it in SiteGuru, then retry the connection.",
      link: `/clients/${exeter!.id}/settings`,
      dedupeKey: `siteguru_missing:${exeter!.id}`,
    },
  ]);

  await db.insert(s.auditLog).values({ actor: "system", entityType: "workspace", event: "seeded" });
  console.log("Seeded.");
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
