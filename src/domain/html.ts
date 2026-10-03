// Minimal, dependency-free HTML extraction for the page inventory. Pure functions.

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}

function clean(s: string | undefined | null): string | null {
  if (!s) return null;
  const t = decode(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  return t || null;
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? "") : null;
}

export type ExtractedPage = {
  title: string | null;
  h1: string | null;
  canonical: string | null;
  noindex: boolean;
  links: string[];
  text: string;
};

export function extractPage(html: string, pageUrl: string): ExtractedPage {
  const head = html.slice(0, 200_000);
  const title = clean(head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const h1 = clean(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]);
  let canonical: string | null = null;
  let noindex = false;
  for (const tag of head.match(/<(link|meta)\b[^>]*>/gi) ?? []) {
    if (/^<link/i.test(tag) && (attr(tag, "rel") ?? "").toLowerCase().split(/\s+/).includes("canonical")) {
      canonical = attr(tag, "href");
    }
    if (/^<meta/i.test(tag) && /^(robots|googlebot)$/i.test(attr(tag, "name") ?? "") && /noindex/i.test(attr(tag, "content") ?? "")) {
      noindex = true;
    }
  }
  const links = new Set<string>();
  for (const tag of html.match(/<a\b[^>]*>/gi) ?? []) {
    const href = attr(tag, "href");
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) continue;
    try {
      links.add(new URL(href, pageUrl).toString());
    } catch {
      /* ignore bad hrefs */
    }
  }
  const body = html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|footer|header)[\s\S]*?<\/\1>/gi, " ");
  const text = clean(body) ?? "";
  return { title, h1, canonical, noindex, links: [...links], text };
}

export function extractSitemapLocs(xml: string): { pages: string[]; sitemaps: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)].map((m) => decode(m[1] ?? "").trim());
  return /<sitemapindex/i.test(xml) ? { pages: [], sitemaps: locs } : { pages: locs, sitemaps: [] };
}

/** Same site (ignoring www) and looks like an HTML page. */
export function isInternalPage(url: string, domain: string): boolean {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    if (u.hostname.replace(/^www\./, "") !== domain.replace(/^www\./, "")) return false;
    return !/\.(png|jpe?g|gif|webp|svg|ico|pdf|zip|css|js|xml|txt|mp4|mp3|woff2?)$/i.test(u.pathname);
  } catch {
    return false;
  }
}

export function canonicalPageUrl(url: string): string {
  const u = new URL(url);
  u.hash = "";
  u.search = "";
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString();
}

/** Heuristic page type, used before (or instead of) LLM classification. */
export function guessPageType(path: string): "homepage" | "blog" | "about" | "contact" | "other" {
  if (path === "/" || path === "") return "homepage";
  if (/^\/(blog|news|articles|insights|guides)(\/|$)/i.test(path)) return "blog";
  if (/^\/(about|about-us|our-story|team)(\/|$)/i.test(path)) return "about";
  if (/^\/(contact|contact-us|get-in-touch)(\/|$)/i.test(path)) return "contact";
  return "other";
}
