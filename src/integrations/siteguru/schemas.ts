import { z } from "zod";

// Shapes confirmed against the live SiteGuru MCP server (see docs/integrations/siteguru.md).
// Only the fields we use are required; everything else passes through.

const range = z.object({ range: z.string(), label: z.string().optional(), start: z.string(), end: z.string() });

export const listSitesSchema = z.object({
  sites: z.array(
    z.object({
      domain: z.string(),
      health_score: z.number().nullable().optional(),
      audit_status: z.string().optional(),
      available_ranges: z.array(range).optional().default([]),
      data_sources: z
        .object({
          search_console: z.object({ connected: z.boolean() }).passthrough().optional(),
          analytics: z.object({ connected: z.boolean() }).passthrough().optional(),
        })
        .optional(),
    }),
  ),
});

const metric = z.object({ value: z.number().nullable(), previous: z.number().nullable().optional(), delta_pct: z.number().nullable().optional() });

export const trafficOverviewSchema = z.object({
  status: z.string(),
  data_period: z.object({ start: z.string(), end: z.string() }).optional(),
  last_refreshed_at: z.string().optional(),
  search_console: z
    .object({
      status: z.string(),
      clicks: metric.optional(),
      impressions: metric.optional(),
      ctr: metric.optional(), // percent, e.g. 0.9 = 0.9%
    })
    .optional(),
  top_pages: z.array(z.object({ path: z.string(), clicks: z.number() }).passthrough()).optional().default([]),
});

export const topKeywordsSchema = z.object({
  status: z.string(),
  keywords: z
    .array(
      z.object({
        keyword: z.string(),
        clicks: metric,
        // avg_position.change = current - previous; negative = moved up. previous 0 = not ranking before.
        avg_position: z.object({ value: z.number().nullable(), previous: z.number().nullable().optional(), change: z.number().nullable().optional() }),
      }),
    )
    .optional()
    .default([]),
});

export type SiteguruSiteRaw = z.infer<typeof listSitesSchema>["sites"][number];
export type TrafficOverview = z.infer<typeof trafficOverviewSchema>;
export type TopKeywords = z.infer<typeof topKeywordsSchema>;
