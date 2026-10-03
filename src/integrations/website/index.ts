import "server-only";
import { canonicalPageUrl, extractPage, extractSitemapLocs, isInternalPage, type ExtractedPage } from "@/domain/html";

const UA = "SEO-Autopilot/1.0 (+site audit; contact via agency)";

async function get(url: string, timeoutMs = 15_000): Promise<Response> {
  return fetch(url, { redirect: "follow", headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml" }, signal: AbortSignal.timeout(timeoutMs) });
}

/** Step 2 of onboarding: reachable (following redirects) and the canonical host. */
export async function checkWebsite(url: string): Promise<{ ok: boolean; finalUrl: string; status: number; domain: string; error?: string }> {
  try {
    const res = await get(url);
    const final = new URL(res.url || url);
    return { ok: res.ok, finalUrl: final.toString(), status: res.status, domain: final.hostname.replace(/^www\./, "") };
  } catch (e) {
    return { ok: false, finalUrl: url, status: 0, domain: new URL(url).hostname, error: e instanceof Error ? e.message : String(e) };
  }
}

export type CrawledPage = ExtractedPage & { url: string; path: string; status: number };

/**
 * sitemap.xml first, then capped breadth-first internal links. Polite: small concurrency, page cap.
 */
export async function crawlSite(origin: string, opts: { maxPages?: number; concurrency?: number } = {}): Promise<{ pages: CrawledPage[]; fromSitemap: number }> {
  const maxPages = opts.maxPages ?? 300;
  const concurrency = opts.concurrency ?? 4;
  const domain = new URL(origin).hostname.replace(/^www\./, "");

  const queue: string[] = [];
  const seen = new Set<string>();
  const enqueue = (u: string) => {
    if (!isInternalPage(u, domain)) return;
    const c = canonicalPageUrl(u);
    if (seen.has(c) || seen.size >= maxPages * 2) return;
    seen.add(c);
    queue.push(c);
  };

  // Sitemap (and one level of sitemap index).
  let fromSitemap = 0;
  try {
    const res = await get(new URL("/sitemap.xml", origin).toString());
    if (res.ok) {
      const { pages, sitemaps } = extractSitemapLocs(await res.text());
      pages.forEach(enqueue);
      for (const sm of sitemaps.slice(0, 10)) {
        const r = await get(sm).catch(() => null);
        if (r?.ok) extractSitemapLocs(await r.text()).pages.forEach(enqueue);
      }
      fromSitemap = queue.length;
    }
  } catch {
    /* no sitemap; fall back to links */
  }
  enqueue(origin);

  const pages: CrawledPage[] = [];
  let i = 0;
  async function worker() {
    while (i < queue.length && pages.length < maxPages) {
      const url = queue[i++]!;
      try {
        const res = await get(url);
        const type = res.headers.get("content-type") ?? "";
        if (!type.includes("html")) continue;
        const html = await res.text();
        const ex = extractPage(html, res.url || url);
        pages.push({ ...ex, url, path: new URL(url).pathname || "/", status: res.status });
        if (fromSitemap === 0 || pages.length < 20) ex.links.forEach(enqueue);
      } catch {
        /* skip unreachable page */
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { pages: pages.slice(0, maxPages), fromSitemap };
}
