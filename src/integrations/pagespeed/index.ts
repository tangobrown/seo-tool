import "server-only";
import { z } from "zod";
import { getProviderKey } from "../keys";
import { callProvider, IntegrationError } from "../run";

// Google PageSpeed Insights v5 (free). Works without a key at low volume; a key raises the quota.

const responseSchema = z.object({
  lighthouseResult: z.object({
    categories: z.object({ performance: z.object({ score: z.number().nullable() }) }),
    audits: z
      .record(z.string(), z.object({ numericValue: z.number().optional(), displayValue: z.string().optional() }))
      .default({}),
  }),
});

export type PageSpeedResult = { url: string; score: number | null; lcpMs: number | null };

export const pagespeed = {
  /** Mobile performance score (0–100) and Largest Contentful Paint for one URL. */
  async run(url: string): Promise<PageSpeedResult> {
    const key = await getProviderKey("pagespeed");
    const qs = new URLSearchParams({ url, strategy: "mobile", category: "performance" });
    if (key) qs.set("key", key);
    return callProvider(
      "pagespeed",
      "runPagespeed",
      async (signal) => {
        const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${qs}`, { signal });
        if (!res.ok) throw new IntegrationError("pagespeed", `PageSpeed ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status >= 500 || res.status === 429);
        const r = responseSchema.parse(await res.json());
        const s = r.lighthouseResult.categories.performance.score;
        const lcp = r.lighthouseResult.audits["largest-contentful-paint"]?.numericValue;
        return { url, score: s == null ? null : Math.round(s * 100), lcpMs: lcp == null ? null : Math.round(lcp) };
      },
      { timeoutMs: 90_000, retries: 1 },
    );
  },
};
