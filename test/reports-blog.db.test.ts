// Phase 8 against Postgres: a monthly report with only verified numbers and completed work, idempotent
// per client and month; blog topics planned only from real demand; behind-schedule attention.
// Assumes no Anthropic key in the test database, so the factual template path is what runs.
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("monthly report and blog commitment", () => {
  let clientId = "";
  const period = "2026-09";

  beforeAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const [tier] = await db.insert(s.tiers).values({ name: `Phase8 ${Date.now()}`, postsPerMonth: 3, scanFrequency: "weekly", pricePence: 0 }).returning();
    const [c] = await db
      .insert(s.clients)
      .values({
        name: "Report Test",
        domain: "reporttest.co.uk",
        websiteUrl: "https://reporttest.co.uk",
        tierId: tier!.id,
        status: "active",
        contactName: "Mrs Jo Bloggs",
        services: ["Boiler servicing", "Boiler repair"],
        locations: ["Exeter"],
        excludedLocations: ["Plymouth"],
      })
      .returning();
    clientId = c!.id;

    // September and August month snapshots (UTC month starts, as the SiteGuru sync stores them).
    await db.insert(s.metricSnapshots).values([
      { clientId, source: "siteguru", kind: "month", periodStart: new Date("2026-09-01T00:00:00Z"), periodEnd: new Date("2026-09-30T00:00:00Z"), metrics: { clicks: 900, impressions: 30000 } },
      { clientId, source: "siteguru", kind: "month", periodStart: new Date("2026-08-01T00:00:00Z"), periodEnd: new Date("2026-08-31T00:00:00Z"), metrics: { clicks: 1000, impressions: 28000 } },
    ]);

    // One piece of work that went live in September (London time), one in October.
    const mk = (title: string, status: "completed" | "recommended" | "reserve", score = 70) => ({
      clientId,
      fingerprint: `${title}-${Date.now()}`,
      type: "metadata",
      category: "on_page" as const,
      title,
      status,
      priorityScore: score,
    });
    const [done, later] = await db.insert(s.opportunities).values([mk("Rewrite the boiler repair page title", "completed"), mk("Fix October thing", "completed")]).returning();
    await db.insert(s.opportunities).values([mk("Add an Exmouth area page", "reserve", 80), mk("Improve the boiler servicing page", "recommended", 90)]);
    const [batch] = await db.insert(s.batches).values({ clientId, idempotencyKey: `p8-${Date.now()}`, startsAt: new Date(), status: "completed" }).returning();
    await db.insert(s.executions).values([
      { batchId: batch!.id, opportunityId: done!.id, executionType: "github_pr", status: "live", idempotencyKey: `p8a-${Date.now()}`, finishedAt: new Date("2026-09-30T22:30:00Z") }, // 23:30 BST, still September
      { batchId: batch!.id, opportunityId: later!.id, executionType: "github_pr", status: "live", idempotencyKey: `p8b-${Date.now()}`, finishedAt: new Date("2026-09-30T23:30:00Z") }, // 00:30 1 Oct London
    ]);

    // Demand signals for blog topics.
    await db.insert(s.siteguruSignals).values({
      clientId,
      signals: {
        keywords: [
          { keyword: "how often should a boiler be serviced", clicks: 3, impressions: 400, position: 14 },
          { keyword: "boiler repair plymouth", clicks: 0, impressions: 300, position: 30 },
          { keyword: "report test reviews", clicks: 5, impressions: 200, position: 1 },
        ],
        lowHangingFruit: [{ keyword: "boiler service cost exeter", path: "/boiler-servicing", clicks: 2, impressions: 250, avgPosition: 11 }],
      },
    });
  });

  afterAll(async () => {
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const [c] = await db.select().from(s.clients).where(eq(s.clients.id, clientId));
    const b = await db.select({ id: s.batches.id }).from(s.batches).where(eq(s.batches.clientId, clientId));
    if (b.length) await db.delete(s.executions).where(inArray(s.executions.batchId, b.map((x) => x.id)));
    for (const t of [s.batches, s.opportunities, s.siteguruSignals, s.metricSnapshots, s.monthlyReports, s.blogCommitments, s.automationRuns, s.auditLog, s.attentionItems] as const) {
      await db.delete(t).where(eq(t.clientId, clientId));
    }
    await db.delete(s.clients).where(eq(s.clients.id, clientId));
    if (c) await db.delete(s.tiers).where(eq(s.tiers.id, c.tierId));
  });

  it("generates a report with verified numbers, the month's work and next steps", async () => {
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const { generateMonthlyReport } = await import("@/server/reports");
    const res = await generateMonthlyReport(clientId, period);
    expect(res.status).toBe("generated");
    expect(res.textSource).toBe("template");
    const [r] = await db.select().from(s.monthlyReports).where(eq(s.monthlyReports.id, res.reportId!));
    expect(r!.summary).toContain("down 10% on August");
    expect(r!.summary).toMatch(/drop/);
    const by = Object.fromEntries(r!.sections.map((x) => [x.title, x.items]));
    expect(by["What we did"]).toEqual(["Rewrite the boiler repair page title"]); // October work excluded
    expect(by["How it performed"]).toEqual(["Visitors from Google search: 900 (down 10% on August)", "Times the site appeared in Google results: 30,000 (up 7% on August)"]);
    expect(by["Next month"]).toEqual(["Improve the boiler servicing page", "Add an Exmouth area page", "Write and publish 3 new blog posts"]);
    expect(r!.emailText.startsWith("Hi Jo,")).toBe(true);
    expect(r!.emailHtml).toContain("<li>Rewrite the boiler repair page title</li>");
    expect((r!.metrics as { subject: string }).subject).toBe("September SEO update — Report Test");
    const [att] = await db.select().from(s.attentionItems).where(eq(s.attentionItems.dedupeKey, `report_ready:${clientId}:${period}`));
    expect(att?.status).toBe("open");
  });

  it("never creates a second report for the same month", async () => {
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const { generateMonthlyReport } = await import("@/server/reports");
    expect((await generateMonthlyReport(clientId, period)).status).toBe("exists");
    const rows = await db.select().from(s.monthlyReports).where(eq(s.monthlyReports.clientId, clientId));
    expect(rows).toHaveLength(1);
  });

  it("leaves performance out when there's no verified data", async () => {
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const { generateMonthlyReport } = await import("@/server/reports");
    const res = await generateMonthlyReport(clientId, "2026-06");
    const [r] = await db.select().from(s.monthlyReports).where(eq(s.monthlyReports.id, res.reportId!));
    expect(r!.sections.map((x) => x.title)).not.toContain("How it performed");
    expect(r!.summary).not.toMatch(/\d/);
  });

  it("plans blog topics only from real demand, and says when there aren't enough", async () => {
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const { planBlogPosts } = await import("@/server/blog");
    const { periodOf } = await import("@/lib/format");
    const now = periodOf(new Date());
    const out = await planBlogPosts(clientId, now);
    expect(out).toMatchObject({ status: "planned", committed: 3, planned: 2, added: 2 });
    const posts = await db.select().from(s.opportunities).where(and(eq(s.opportunities.clientId, clientId), eq(s.opportunities.isBlogCommitment, true)));
    expect(posts.map((p) => p.targetQuery).sort()).toEqual(["boiler service cost exeter", "how often should a boiler be serviced"]);
    expect(posts.every((p) => p.evidence.length > 0 && p.status === "candidate" && p.type === "blog_content")).toBe(true);
    const [att] = await db.select().from(s.attentionItems).where(eq(s.attentionItems.dedupeKey, `blog_topics_short:${clientId}:${now}`));
    expect(att?.title).toBe("Only 2 of 3 blog topics found for Report Test");
    const [commit] = await db.select().from(s.blogCommitments).where(and(eq(s.blogCommitments.clientId, clientId), eq(s.blogCommitments.period, now)));
    expect(commit).toMatchObject({ committed: 3, planned: 2 });

    // Re-running adds nothing new.
    expect((await planBlogPosts(clientId, now)).added).toBe(0);
  });

  it("asks for an Anthropic key instead of drafting without one", async () => {
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const { draftBlogWave } = await import("@/server/blog");
    const out = await draftBlogWave(clientId);
    expect(out).toMatchObject({ status: "skipped", reason: "No Anthropic key" });
    const items = await db.select().from(s.attentionItems).where(and(eq(s.attentionItems.clientId, clientId), eq(s.attentionItems.kind, "blog_commitment")));
    expect(items.some((i) => i.title.includes("can’t be drafted"))).toBe(true);
  });

  it("flags a commitment that's behind in the final week", async () => {
    const { db } = await import("@/db");
    const s = await import("@/db/schema");
    const { checkBlogCommitment } = await import("@/server/blog");
    const { periodOf } = await import("@/lib/format");
    const { londonMonthBounds } = await import("@/domain/schedule");
    const now = periodOf(new Date());
    const end = londonMonthBounds(now).end;
    const finalWeek = new Date(end.getTime() - 3 * 86400_000);
    expect((await checkBlogCommitment(clientId, finalWeek)).behind).toBe(true);
    const [att] = await db.select().from(s.attentionItems).where(eq(s.attentionItems.dedupeKey, `blog_behind:${clientId}:${now}`));
    expect(att?.title).toBe("Report Test: 3 of 3 blog posts still to approve");
    const early = londonMonthBounds(now).start;
    expect((await checkBlogCommitment(clientId, new Date(early.getTime() + 2 * 86400_000))).behind).toBe(false);
    const [after] = await db.select().from(s.attentionItems).where(eq(s.attentionItems.dedupeKey, `blog_behind:${clientId}:${now}`));
    expect(after?.status).toBe("resolved");
  });
});
