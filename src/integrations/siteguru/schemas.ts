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
        impressions: metric.optional(),
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

const todoTask = z.object({
  checkName: z.string(),
  severity: z.string().optional().default("medium"),
  title: z.string(),
  description: z.string().optional(),
  affectedPages: z.union([z.number(), z.boolean()]).optional(),
  report_url: z.string().optional(),
});
export const todoListSchema = z.object({
  site_context: z.object({ cms: z.string().optional() }).passthrough().optional(),
  todo: z.record(z.string(), z.object({ tasks: z.array(todoTask).optional().default([]) }).passthrough()).optional().default({}),
});

export const lowHangingFruitSchema = z.object({
  status: z.string(),
  opportunities: z
    .array(z.object({ keyword: z.string(), path: z.string(), clicks: z.number(), impressions: z.number(), avg_position: z.number() }))
    .optional()
    .default([]),
});

export const decliningSchema = z.object({
  data_status: z.string(),
  months: z.array(z.string()).optional().default([]),
  pages: z
    .array(
      z.object({
        path: z.string(),
        net_change: z.number(),
        percent_change: z.number(),
        oldest_month_clicks: z.number(),
        newest_month_clicks: z.number(),
      }),
    )
    .optional()
    .default([]),
});

export const cannibalizationSchema = z.object({
  status: z.string(),
  keywords: z
    .array(
      z.object({
        keyword: z.string(),
        impressions: metric,
        avg_position: z.object({ value: z.number().nullable() }),
        competing_pages: z.array(z.object({ path: z.string(), clicks: metric, avg_position: z.object({ value: z.number().nullable() }) })),
      }),
    )
    .optional()
    .default([]),
});

export type TodoList = z.infer<typeof todoListSchema>;
export type LowHangingFruit = z.infer<typeof lowHangingFruitSchema>;
export type Declining = z.infer<typeof decliningSchema>;
export type Cannibalization = z.infer<typeof cannibalizationSchema>;
