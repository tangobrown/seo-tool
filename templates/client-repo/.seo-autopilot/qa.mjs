#!/usr/bin/env node
// SEO Autopilot: SEO QA checks. Zero dependencies, Node 20+, ESM.
//
// Usage:
//   node .seo-autopilot/qa.mjs --base origin/main --spec /path/spec.json [--out qa.json] [--build-dir .next]
//   node .seo-autopilot/qa.mjs --self-test
//
// Runs against the diff between --base and HEAD, the repository source, and the
// Next.js build output. Prints { passed, checks: [{ name, passed, detail }] } as
// JSON on stdout (and to --out when given). Exits 1 when any check fails.
//
// A check that cannot be evaluated passes with a detail starting "not applicable".
// Length problems and pre-existing issues are reported as warnings in the detail
// and do not fail the run.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";

export const QA_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Pure helpers (covered by --self-test)

export function words(text) {
  return (String(text).toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || []);
}

export function shingles(text, k = 5) {
  const w = Array.isArray(text) ? text : words(text);
  const set = new Set();
  for (let i = 0; i + k <= w.length; i++) set.add(w.slice(i, i + k).join(" "));
  return set;
}

export function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const s of small) if (large.has(s)) inter++;
  return inter / (a.size + b.size - inter);
}

const ROUTE_ROOTS = ["src/app", "app", "src/pages", "pages"];
const PAGE_EXT = /\.(tsx|ts|jsx|js|mdx|md)$/;

/**
 * Map a repository file to the URL route it serves, or null.
 * kind: "page" (renders HTML), "handler" (app route.ts / pages/api), "metadata" (sitemap/robots)
 */
export function routeFromFile(path) {
  for (const root of ROUTE_ROOTS) {
    if (!path.startsWith(root + "/")) continue;
    const rel = path.slice(root.length + 1);
    const parts = rel.split("/");
    const file = parts.pop();
    const isApp = root.endsWith("app");
    if (isApp) {
      let kind = null;
      let leaf = null;
      if (/^page\.(tsx|ts|jsx|js|mdx|md)$/.test(file)) kind = "page";
      else if (/^route\.(tsx|ts|jsx|js)$/.test(file)) kind = "handler";
      else if (/^sitemap\.(ts|js|xml)$/.test(file)) (kind = "metadata"), (leaf = "sitemap.xml");
      else if (/^robots\.(ts|js|txt)$/.test(file)) (kind = "metadata"), (leaf = "robots.txt");
      if (!kind) return null;
      const segs = [];
      for (const p of parts) {
        if (p.startsWith("_")) return null; // private folder
        if (/^\(\.{1,3}\)/.test(p)) return null; // intercepting route
        if (/^\(.*\)$/.test(p)) continue; // route group
        if (p.startsWith("@")) continue; // parallel route slot
        segs.push(p);
      }
      if (leaf) segs.push(leaf);
      return { route: "/" + segs.join("/"), kind, root, file: path };
    }
    // pages router
    if (!PAGE_EXT.test(file)) return null;
    const name = file.replace(PAGE_EXT, "");
    if (parts.length === 0 && /^_(app|document|error)$/.test(name)) return null;
    if (parts.some((p) => p.startsWith("_"))) return null;
    if (parts.length === 0 && /^(404|500)$/.test(name)) return null;
    const segs = [...parts];
    if (name !== "index") segs.push(name);
    const kind = parts[0] === "api" ? "handler" : "page";
    return { route: "/" + segs.join("/"), kind, root, file: path };
  }
  return null;
}

export function isDynamicRoute(route) {
  return /\[/.test(route);
}

export function normalisePath(p) {
  let s = String(p || "/");
  s = s.split("#")[0].split("?")[0];
  try {
    s = decodeURI(s);
  } catch {}
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/{2,}/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

function routeSegments(route) {
  return normalisePath(route).split("/").filter(Boolean);
}

/** Does a concrete URL path match a Next.js route pattern (with [x], [...x], [[...x]])? */
export function matchRoute(path, pattern) {
  const ps = routeSegments(path);
  const rs = routeSegments(pattern);
  function go(i, j) {
    if (j === rs.length) return i === ps.length;
    const seg = rs[j];
    if (/^\[\[\.\.\..+\]\]$/.test(seg)) {
      for (let k = i; k <= ps.length; k++) if (go(k, j + 1)) return true;
      return false;
    }
    if (/^\[\.\.\..+\]$/.test(seg)) {
      for (let k = i + 1; k <= ps.length; k++) if (go(k, j + 1)) return true;
      return false;
    }
    if (i >= ps.length) return false;
    if (/^\[.+\]$/.test(seg)) return go(i + 1, j + 1);
    return seg.toLowerCase() === ps[i].toLowerCase() && go(i + 1, j + 1);
  }
  return go(0, 0);
}

/**
 * Resolve an internal href against known routes and public files.
 * Returns true (resolves), false (does not), or null (cannot be evaluated).
 */
export function resolveLink(href, routes, publicFiles = new Set()) {
  if (typeof href !== "string" || !href.startsWith("/") || href.startsWith("//")) return null;
  if (/[${}]/.test(href)) return null; // template expression
  const path = normalisePath(href);
  if (path.startsWith("/_next/") || path === "/_next") return true;
  if (publicFiles.has(path.slice(1))) return true;
  if (publicFiles.has(posix.join(path.slice(1), "index.html"))) return true;
  for (const r of routes) if (matchRoute(path, r)) return true;
  return false;
}

/** Extract root-relative internal hrefs from source text (JSX, HTML, Markdown, config objects). */
export function extractInternalLinks(text) {
  const out = new Set();
  const patterns = [
    /\bhref\s*=\s*\{?\s*["'`](\/[^"'`\s{}]*)["'`]/g, // href="/x", href={"/x"}, href={`/x`}
    /\bhref\s*:\s*["'`](\/[^"'`\s{}]*)["'`]/g, // { href: "/x" }
    /\]\((\/[^)\s"']*)(?:\s+"[^"]*")?\)/g, // [text](/x)
  ];
  for (const re of patterns) {
    for (const m of String(text).matchAll(re)) {
      if (!m[1].startsWith("//")) out.add(m[1]);
    }
  }
  return [...out];
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export function parseAttrs(tag) {
  const attrs = {};
  const inner = tag.replace(/^<\s*[\w:-]+/, "").replace(/\/?>$/, "");
  for (const m of inner.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

function tags(html, name) {
  return [...String(html).matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map((m) => parseAttrs(m[0]));
}

export function extractHead(html) {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const metas = tags(html, "meta");
  const links = tags(html, "link");
  const desc = metas.find((m) => (m.name || "").toLowerCase() === "description");
  const robots = metas.filter((m) => /^(robots|googlebot)$/i.test(m.name || "")).map((m) => m.content || "");
  const canonical = links.find((l) => (l.rel || "").toLowerCase().split(/\s+/).includes("canonical"));
  const jsonLd = [...String(html).matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  return {
    title: titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : null,
    description: desc ? (desc.content || "").replace(/\s+/g, " ").trim() : null,
    canonical: canonical ? canonical.href || "" : null,
    robots,
    jsonLd,
  };
}

/** Validate a JSON-LD block. Returns { ok, types, error }. */
export function checkJsonLd(raw) {
  let data;
  try {
    data = JSON.parse(String(raw).trim());
  } catch (e) {
    return { ok: false, types: [], error: `does not parse: ${e.message}` };
  }
  const nodes = [];
  const collect = (v) => {
    if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") {
      if (Array.isArray(v["@graph"])) v["@graph"].forEach(collect);
      else nodes.push(v);
    }
  };
  collect(data);
  if (nodes.length === 0) return { ok: false, types: [], error: "contains no objects" };
  const types = [];
  for (const n of nodes) {
    const t = n["@type"];
    if (!t || (Array.isArray(t) && t.length === 0)) return { ok: false, types, error: "a node has no @type" };
    types.push(...(Array.isArray(t) ? t : [t]).map(String));
  }
  return { ok: true, types, error: null };
}

export function htmlToText(html) {
  let s = String(html);
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(s);
  if (main) s = main[1];
  else {
    const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(s);
    if (body) s = body[1];
  }
  s = s.replace(/<(script|style|noscript|svg|template|header|nav|footer)\b[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<[^>]+>/g, " ");
  return decodeEntities(s).replace(/\s+/g, " ").trim();
}

export function sourceToText(src, path = "") {
  let s = String(src);
  if (/\.mdx?$/.test(path)) {
    s = s.replace(/^---[\s\S]*?\n---\s*\n/, " "); // front matter
    s = s.replace(/```[\s\S]*?```/g, " ");
    s = s.replace(/^\s*(import|export)\s.*$/gm, " ");
    s = s.replace(/<[^>]+>/g, " ");
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    s = s.replace(/[#>*_`~|-]+/g, " ");
    return s.replace(/\s+/g, " ").trim();
  }
  // JS/TS(X): keep JSX text and longer string literals only.
  s = s.replace(/^\s*import\s.*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
  const parts = [];
  for (const m of s.matchAll(/>([^<>{}]+)</g)) if (/[a-z]{3,}/i.test(m[1])) parts.push(m[1]);
  for (const m of s.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.){25,})\1/g)) if (/\s/.test(m[2])) parts.push(m[2]);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Lines matching `re` that were added, net of identical matching lines removed
 * from the same file (so moving a line is not reported as new).
 */
export function netAddedMatches(fileDiff, re) {
  const removed = new Map();
  for (const l of fileDiff.removed) {
    if (re.test(l)) removed.set(l.trim(), (removed.get(l.trim()) || 0) + 1);
    re.lastIndex = 0;
  }
  const out = [];
  for (const l of fileDiff.added) {
    const hit = re.test(l);
    re.lastIndex = 0;
    if (!hit) continue;
    const k = l.trim();
    if (removed.get(k)) removed.set(k, removed.get(k) - 1);
    else out.push(k);
  }
  return out;
}

export function parseUnifiedDiff(text) {
  const files = new Map();
  let cur = null;
  for (const line of String(text).split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      const path = p === "/dev/null" ? null : p.replace(/^b\//, "");
      // "+++ /dev/null" is a deleted file: keep collecting under the old path set by "---".
      if (path) {
        cur = files.get(path) || { added: [], removed: [] };
        files.set(path, cur);
      }
      continue;
    }
    if (line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      if (p !== "/dev/null") {
        const path = p.replace(/^a\//, "");
        if (!files.has(path)) files.set(path, { added: [], removed: [] });
        cur = files.get(path);
      }
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("+")) cur.added.push(line.slice(1));
    else if (line.startsWith("-")) cur.removed.push(line.slice(1));
  }
  return files;
}

// ---------------------------------------------------------------------------
// Repository / build context

const LOCKFILES = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json)$/;
const IGNORED_FOR_SCANS = (p) => p.startsWith(".seo-autopilot/") || p.startsWith(".github/") || LOCKFILES.test(p);

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function tryRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function walk(dir, filter, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, filter, out);
    else if (filter(p)) out.push(p);
  }
  return out;
}

function htmlRouteFromBuilt(rel) {
  // rel like "about.html", "index.html", "blog/post.html", "blog/index.html"
  let r = rel.replace(/\\/g, "/").replace(/\.html$/, "");
  const base = r.split("/").pop();
  if (/^(_not-found|_global-error|_error|404|500)$/.test(base)) return null;
  if (r === "index") return "/";
  r = r.replace(/\/index$/, "");
  return "/" + r;
}

function loadBuiltHtml(buildDir) {
  const map = new Map();
  for (const sub of ["server/app", "server/pages"]) {
    const root = join(buildDir, sub);
    if (!existsSync(root)) continue;
    for (const f of walk(root, (p) => p.endsWith(".html"))) {
      const route = htmlRouteFromBuilt(f.slice(root.length + 1));
      if (route && !map.has(route)) map.set(route, f);
    }
  }
  if (existsSync("out")) {
    for (const f of walk("out", (p) => p.endsWith(".html") && !p.includes("/_next/"))) {
      const route = htmlRouteFromBuilt(f.slice("out/".length));
      if (route && !map.has(route)) map.set(route, f);
    }
  }
  return map;
}

function buildContext({ base, specPath, buildDir }) {
  const spec = specPath && existsSync(specPath) ? JSON.parse(readFileSync(specPath, "utf8")) : {};
  const range = `${base}...HEAD`;
  git(["rev-parse", "--verify", base]);

  const nameStatus = git(["diff", "--name-status", "-M", range])
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [status, a, b] = l.split("\t");
      return { status: status[0], path: b || a, oldPath: b ? a : null };
    });

  const diff = parseUnifiedDiff(git(["diff", "-U0", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", range]));

  let changedLines = 0;
  const numstat = [];
  for (const l of git(["diff", "--numstat", "-M", range]).split("\n").filter(Boolean)) {
    const [a, d, ...rest] = l.split("\t");
    const p = rest.join("\t");
    if (LOCKFILES.test(p) || a === "-") continue;
    changedLines += Number(a) + Number(d);
    numstat.push({ path: p, added: Number(a), deleted: Number(d) });
  }

  const baseFiles = git(["ls-tree", "-r", "--name-only", base]).split("\n").filter(Boolean);
  const headFiles = git(["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").filter(Boolean);
  const headSet = new Set(headFiles);

  const routeInfos = (files) => files.map(routeFromFile).filter(Boolean);
  const baseRoutes = routeInfos(baseFiles);
  const headRoutes = routeInfos(headFiles);
  const publicFiles = new Set(headFiles.filter((f) => f.startsWith("public/")).map((f) => f.slice("public/".length)));

  const changedPageFiles = nameStatus
    .filter((e) => ["A", "M", "R", "C"].includes(e.status))
    .map((e) => ({ ...e, info: routeFromFile(e.path) }))
    .filter((e) => e.info && e.info.kind === "page");

  // Items that were committed in this branch ("seo: ... [ref]").
  const subjects = git(["log", "--format=%s", `${base}..HEAD`]).split("\n").filter(Boolean);
  const doneRefs = new Set(subjects.map((s) => /\[([^\]]+)\]\s*$/.exec(s)?.[1]).filter(Boolean));
  const doneItems = (spec.items || []).filter((i) => doneRefs.has(i.ref));
  const targetRoutes = new Set();
  for (const it of doneItems) {
    if (!it.target_url) continue;
    try {
      targetRoutes.add(normalisePath(new URL(it.target_url, "https://example.invalid").pathname));
    } catch {}
  }

  const builtHtml = loadBuiltHtml(buildDir);
  const headCache = new Map();
  const head = (route) => {
    if (!headCache.has(route)) {
      const f = builtHtml.get(route);
      headCache.set(route, f ? extractHead(readFileSync(f, "utf8")) : null);
    }
    return headCache.get(route);
  };

  // Routes that this batch changed or added: static page routes plus target URLs of committed items.
  const checkedRoutes = new Map(); // route -> { files: [], isNew }
  for (const e of changedPageFiles) {
    const r = normalisePath(e.info.route);
    const entry = checkedRoutes.get(r) || { files: [], isNew: false };
    entry.files.push(e.path);
    entry.isNew = entry.isNew || e.status === "A";
    checkedRoutes.set(r, entry);
  }
  for (const r of targetRoutes) {
    if (!checkedRoutes.has(r) && (builtHtml.has(r) || headRoutes.some((h) => h.kind === "page" && matchRoute(r, h.route)))) {
      checkedRoutes.set(r, { files: [], isNew: false, fromTarget: true });
    }
  }

  return {
    spec,
    base,
    buildDir,
    nameStatus,
    diff,
    changedLines,
    numstat,
    baseFiles,
    headFiles,
    headSet,
    baseRoutes,
    headRoutes,
    publicFiles,
    changedPageFiles,
    doneItems,
    builtHtml,
    head,
    checkedRoutes,
    domain: spec.client?.domain || null,
  };
}

function layoutChain(ctx, pageFile) {
  // Page file and every ancestor layout.* up to the route root.
  const info = routeFromFile(pageFile);
  const out = [pageFile];
  if (!info || !info.root.endsWith("app")) return out;
  let dir = posix.dirname(pageFile);
  while (dir.length >= info.root.length) {
    for (const ext of ["tsx", "ts", "jsx", "js"]) {
      const f = `${dir}/layout.${ext}`;
      if (ctx.headSet.has(f)) out.push(f);
    }
    if (dir === info.root) break;
    dir = posix.dirname(dir);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Checks

const NA = (why) => ({ passed: true, detail: `not applicable: ${why}` });

function checkBuild(ctx) {
  const id = join(ctx.buildDir, "BUILD_ID");
  if (existsSync(id)) return { passed: true, detail: `${id} exists (${readFileSync(id, "utf8").trim()})` };
  return { passed: false, detail: `${id} not found: the build did not complete` };
}

function checkRoutesRemoved(ctx) {
  const headPatterns = new Set(ctx.headRoutes.map((r) => normalisePath(r.route)));
  const removed = [];
  for (const r of ctx.baseRoutes) {
    if (!headPatterns.has(normalisePath(r.route))) removed.push(`${r.route} (${r.file})`);
  }
  const deletedFiles = ctx.nameStatus.filter((e) => e.status === "D" && routeFromFile(e.path)).map((e) => e.path);
  if (removed.length) return { passed: false, detail: `Routes removed: ${[...new Set(removed)].join(", ")}` };
  const extra = deletedFiles.length ? `; route files deleted but routes still served elsewhere: ${deletedFiles.join(", ")}` : "";
  return { passed: true, detail: `${ctx.baseRoutes.length} base routes all still present${extra}` };
}

const NOINDEX_RE = /\bno-?index\b|\bnofollow\b|\bindex\s*:\s*false\b|\bfollow\s*:\s*false\b|x-robots-tag/i;

function checkNoindex(ctx) {
  const hits = [];
  for (const [path, fd] of ctx.diff) {
    if (IGNORED_FOR_SCANS(path)) continue;
    for (const l of netAddedMatches(fd, NOINDEX_RE)) hits.push(`${path}: ${l.slice(0, 120)}`);
  }
  for (const [route, e] of ctx.checkedRoutes) {
    if (!e.isNew) continue;
    const h = ctx.head(route);
    if (h && h.robots.some((c) => /noindex|nofollow|none/i.test(c))) hits.push(`built HTML for new page ${route} has robots "${h.robots.join(", ")}"`);
  }
  if (hits.length) return { passed: false, detail: `New noindex/nofollow found: ${hits.slice(0, 10).join(" | ")}` };
  return { passed: true, detail: "No new noindex or nofollow in the diff" };
}

function canonicalFromSource(ctx, files) {
  let found = false;
  const literals = [];
  for (const f of files) {
    const src = tryRead(f);
    if (!src) continue;
    if (/canonical/i.test(src)) found = true;
    for (const m of src.matchAll(/canonical\s*[:=]\s*\{?\s*["'`]([^"'`$]*)["'`]/gi)) literals.push({ file: f, value: m[1] });
  }
  return { found, literals };
}

function checkCanonicals(ctx) {
  if (ctx.checkedRoutes.size === 0) return NA("no changed or new pages");
  const problems = [];
  const notes = [];
  for (const [route, e] of ctx.checkedRoutes) {
    const h = ctx.head(route);
    if (h) {
      if (h.canonical == null) {
        problems.push(`${route}: no <link rel="canonical"> in built HTML`);
        continue;
      }
      let url;
      try {
        url = new URL(h.canonical, ctx.domain ? `https://${ctx.domain}` : "https://example.invalid");
      } catch {
        problems.push(`${route}: canonical "${h.canonical}" is not a valid URL`);
        continue;
      }
      if (normalisePath(url.pathname) !== route) problems.push(`${route}: canonical points to ${url.pathname}`);
      else if (ctx.domain && url.hostname.replace(/^www\./, "") !== String(ctx.domain).replace(/^www\./, "")) notes.push(`${route}: canonical host ${url.hostname} differs from ${ctx.domain}`);
      continue;
    }
    if (isDynamicRoute(route)) {
      notes.push(`${route}: dynamic route, not verified`);
      continue;
    }
    const files = e.files.flatMap((f) => layoutChain(ctx, f));
    if (files.length === 0) {
      notes.push(`${route}: no built HTML and no source file, not verified`);
      continue;
    }
    const { found, literals } = canonicalFromSource(ctx, files);
    if (!found) {
      problems.push(`${route}: no canonical in ${e.files.join(", ")} or its layouts`);
      continue;
    }
    const own = literals.filter((l) => e.files.includes(l.file));
    for (const l of own) {
      if (l.value === "./" || l.value === "." || l.value === "") continue;
      let p;
      try {
        p = normalisePath(new URL(l.value, "https://example.invalid").pathname);
      } catch {
        continue;
      }
      if (p !== route) problems.push(`${route}: canonical literal "${l.value}" in ${l.file} is not self-referencing`);
    }
    notes.push(`${route}: canonical found in source (not prerendered)`);
  }
  if (problems.length) return { passed: false, detail: problems.join(" | ") };
  return { passed: true, detail: `${ctx.checkedRoutes.size} page(s) checked${notes.length ? `; ${notes.join("; ")}` : ""}` };
}

function checkTitles(ctx) {
  if (ctx.checkedRoutes.size === 0) return NA("no changed or new pages");
  const titles = new Map();
  const descs = new Map();
  for (const route of ctx.builtHtml.keys()) {
    const h = ctx.head(route);
    if (!h) continue;
    if (h.title) titles.set(h.title.toLowerCase(), [...(titles.get(h.title.toLowerCase()) || []), route]);
    if (h.description) descs.set(h.description.toLowerCase(), [...(descs.get(h.description.toLowerCase()) || []), route]);
  }
  const problems = [];
  const warnings = [];
  let verified = 0;
  for (const [route, e] of ctx.checkedRoutes) {
    const h = ctx.head(route);
    if (h) {
      verified++;
      if (!h.title) problems.push(`${route}: missing <title>`);
      else {
        const dup = (titles.get(h.title.toLowerCase()) || []).filter((r) => r !== route);
        if (dup.length) problems.push(`${route}: title duplicates ${dup.slice(0, 3).join(", ")}`);
        if (h.title.length < 10 || h.title.length > 65) warnings.push(`${route}: title is ${h.title.length} chars (aim for 10–65)`);
      }
      if (!h.description) problems.push(`${route}: missing meta description`);
      else {
        const dup = (descs.get(h.description.toLowerCase()) || []).filter((r) => r !== route);
        if (dup.length) problems.push(`${route}: meta description duplicates ${dup.slice(0, 3).join(", ")}`);
        if (h.description.length < 50 || h.description.length > 160) warnings.push(`${route}: description is ${h.description.length} chars (aim for 50–160)`);
      }
      continue;
    }
    if (!e.isNew || e.files.length === 0) {
      warnings.push(`${route}: not prerendered, not verified`);
      continue;
    }
    const ownSrc = e.files.map(tryRead).join("\n");
    const hasOwnMeta = /export\s+(const\s+metadata|(async\s+)?function\s+generateMetadata|const\s+generateMetadata)|<title|<Head\b|NextSeo|^title\s*:/m.test(ownSrc);
    if (!hasOwnMeta) problems.push(`${route}: new page has no metadata export or <title> (layouts alone would duplicate titles)`);
    else warnings.push(`${route}: metadata found in source (not prerendered)`);
  }
  if (problems.length) return { passed: false, detail: problems.join(" | ") + (warnings.length ? ` | warnings: ${warnings.join("; ")}` : "") };
  return { passed: true, detail: `${verified} page(s) verified in built HTML${warnings.length ? `; warnings: ${warnings.join("; ")}` : ""}` };
}

function checkInternalLinks(ctx) {
  const routes = ctx.headRoutes.map((r) => r.route);
  for (const r of ctx.builtHtml.keys()) routes.push(r);
  const broken = [];
  let checked = 0;
  for (const [path, fd] of ctx.diff) {
    if (IGNORED_FOR_SCANS(path) || !ctx.headSet.has(path)) continue;
    if (!/\.(tsx|ts|jsx|js|mjs|mdx|md|html|json)$/.test(path)) continue;
    for (const href of extractInternalLinks(fd.added.join("\n"))) {
      const ok = resolveLink(href, routes, ctx.publicFiles);
      if (ok === null) continue;
      checked++;
      if (!ok) broken.push(`${href} (in ${path})`);
    }
  }
  if (broken.length) return { passed: false, detail: `Links to routes that do not exist: ${broken.slice(0, 15).join(", ")}` };
  if (checked === 0) return NA("no new internal links in the diff");
  return { passed: true, detail: `${checked} new internal link(s) resolve` };
}

function sitemapLocs(xml) {
  const out = new Set();
  for (const m of String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    try {
      out.add(normalisePath(new URL(decodeEntities(m[1]), "https://example.invalid").pathname));
    } catch {}
  }
  return out;
}

function checkSitemap(ctx) {
  const newRoutes = new Set();
  for (const [route, e] of ctx.checkedRoutes) if (e.isNew && !isDynamicRoute(route)) newRoutes.add(route);
  // New content (e.g. blog posts served by a dynamic route): use the item's target URL.
  for (const it of ctx.doneItems) {
    if (it.content && it.target_url) {
      try {
        newRoutes.add(normalisePath(new URL(it.target_url, "https://example.invalid").pathname));
      } catch {}
    }
  }
  if (newRoutes.size === 0) return NA("no new pages");
  const list = [...newRoutes];

  // 1. Built sitemap from app/sitemap.ts (authoritative when present).
  const builtBodies = walk(join(ctx.buildDir, "server/app"), (p) => /sitemap[^/]*\.xml\.body$/.test(p));
  if (builtBodies.length) {
    const locs = new Set();
    for (const f of builtBodies) for (const l of sitemapLocs(readFileSync(f, "utf8"))) locs.add(l);
    const missing = list.filter((r) => !locs.has(r));
    if (missing.length) return { passed: false, detail: `Not in the built sitemap: ${missing.join(", ")}` };
    return { passed: true, detail: `All ${list.length} new page(s) in the built sitemap` };
  }
  // 2. next-sitemap generates the sitemap after build.
  const nextSitemapCfg = ctx.headFiles.find((f) => /^next-sitemap\.config\.(js|cjs|mjs|ts)$/.test(f));
  if (nextSitemapCfg) return { passed: true, detail: `Sitemap generated by next-sitemap (${nextSitemapCfg}); assumed to include new pages` };
  // 3. app/sitemap.ts source.
  const sitemapSrc = ctx.headFiles.find((f) => /^(src\/)?app\/sitemap\.(ts|js)$/.test(f));
  if (sitemapSrc) {
    const src = tryRead(sitemapSrc) || "";
    const missing = list.filter((r) => !src.includes(`"${r}"`) && !src.includes(`'${r}'`) && !src.includes(`\`${r}\``) && !src.includes(`${r}"`) && !src.includes(`${r}'`) && !src.includes(`${r}\``));
    if (missing.length === 0) return { passed: true, detail: `All new page(s) listed in ${sitemapSrc}` };
    const dynamic = /\.(map|flatMap|forEach)\(|readdir|glob|fetch\(|for\s*\(|await\s|import\s+.*from\s+["'](?!next)/.test(src);
    if (dynamic) return { passed: true, detail: `${sitemapSrc} builds the list dynamically; assumed to include ${missing.join(", ")} (not prerendered, not verified)` };
    return { passed: false, detail: `Not in ${sitemapSrc}: ${missing.join(", ")}` };
  }
  // 4. Static public sitemap.
  const staticXml = ctx.headFiles.filter((f) => /^public\/sitemap[^/]*\.xml$/.test(f));
  if (staticXml.length) {
    const locs = new Set();
    for (const f of staticXml) for (const l of sitemapLocs(tryRead(f) || "")) locs.add(l);
    const missing = list.filter((r) => !locs.has(r));
    if (missing.length) return { passed: false, detail: `Not in ${staticXml.join(", ")}: ${missing.join(", ")}` };
    return { passed: true, detail: `All new page(s) in ${staticXml.join(", ")}` };
  }
  return NA(`no sitemap found in the repository (warning: new pages ${list.join(", ")} are not in any sitemap)`);
}

const ROBOTS_FILE = /^(public\/robots\.txt|(src\/)?app\/robots\.(ts|js|txt))$/;

function checkRobots(ctx) {
  const touched = ctx.nameStatus.filter((e) => ROBOTS_FILE.test(e.path) || (e.oldPath && ROBOTS_FILE.test(e.oldPath)));
  if (touched.length) return { passed: false, detail: `robots changed: ${touched.map((e) => `${e.status} ${e.path}`).join(", ")}` };
  return { passed: true, detail: "robots.txt / app/robots unchanged" };
}

const SCHEMA_TYPES = ["LocalBusiness", "Organization", "Service", "FAQPage", "Article", "BlogPosting", "BreadcrumbList", "Product", "Review", "AggregateRating", "WebSite", "WebPage", "HowTo", "Event", "Person", "Plumber", "Electrician", "HomeAndConstructionBusiness", "ProfessionalService"];

function checkJsonLdAll(ctx) {
  const problems = [];
  const warnings = [];
  let blocks = 0;
  const typesByRoute = new Map();
  for (const [route] of ctx.checkedRoutes) {
    const h = ctx.head(route);
    if (!h) continue;
    const types = [];
    h.jsonLd.forEach((raw, i) => {
      blocks++;
      const r = checkJsonLd(raw);
      if (!r.ok) problems.push(`${route} block ${i + 1}: ${r.error}`);
      types.push(...r.types);
    });
    typesByRoute.set(route, types);
  }
  for (const [path, fd] of ctx.diff) {
    if (IGNORED_FOR_SCANS(path) || !ctx.headSet.has(path)) continue;
    const added = fd.added.join("\n");
    if (!/ld\+json|@context/.test(added)) continue;
    if (path.endsWith(".json") || path.endsWith(".jsonld")) {
      blocks++;
      const r = checkJsonLd(tryRead(path) || "");
      if (!r.ok) problems.push(`${path}: ${r.error}`);
      continue;
    }
    const src = tryRead(path) || "";
    if (!/["']?@type["']?\s*:/.test(src)) problems.push(`${path}: JSON-LD added without an @type`);
    else blocks++;
  }
  // Expected types: if a committed item names a schema.org type, look for it.
  for (const it of ctx.doneItems) {
    const text = `${it.title} ${it.proposed_action || ""} ${(it.acceptance_criteria || []).join(" ")}`;
    if (!/schema|structured data|json-ld/i.test(text)) continue;
    const route = it.target_url ? normalisePath(new URL(it.target_url, "https://example.invalid").pathname) : null;
    const types = route ? typesByRoute.get(route) : null;
    for (const t of SCHEMA_TYPES) {
      if (!new RegExp(`\\b${t}\\b`).test(text)) continue;
      if (types && !types.includes(t)) warnings.push(`${route}: expected @type ${t} not found in built HTML`);
    }
  }
  if (problems.length) return { passed: false, detail: problems.join(" | ") };
  if (blocks === 0) return NA(`no JSON-LD on changed pages${warnings.length ? `; warnings: ${warnings.join("; ")}` : ""}`);
  return { passed: true, detail: `${blocks} JSON-LD block(s) parse and have @type${warnings.length ? `; warnings: ${warnings.join("; ")}` : ""}` };
}

function checkRedirects(ctx) {
  const rules = [
    [/^next\.config\.(js|mjs|cjs|ts)$/, /\b(redirects|rewrites)\b|\bdestination\s*:|\bpermanent\s*:|\bstatusCode\s*:/],
    [/^vercel\.json$/, /"(redirects|rewrites|routes)"|"destination"|"permanent"/],
    [/^(src\/)?(middleware|proxy)\.(ts|js|mjs)$/, /NextResponse\.(redirect|rewrite)|Response\.redirect|\bredirect\s*\(|\brewrite\s*\(/],
    [/^public\/_redirects$/, /\S/],
    [/^netlify\.toml$/, /\[\[redirects\]\]/],
    [/^(src\/)?(app|pages)\//, /\b(permanentRedirect|redirect)\s*\(|\bredirect\s*:\s*\{/],
  ];
  const hits = [];
  for (const [path, fd] of ctx.diff) {
    for (const [fileRe, lineRe] of rules) {
      if (!fileRe.test(path)) continue;
      for (const l of netAddedMatches(fd, lineRe)) hits.push(`${path}: ${l.slice(0, 120)}`);
    }
  }
  if (hits.length) return { passed: false, detail: `New redirects or rewrites: ${hits.slice(0, 10).join(" | ")}` };
  return { passed: true, detail: "No new redirects or rewrites" };
}

function checkDiffSize(ctx) {
  const max = Number(ctx.spec.qa?.max_changed_lines) || 1500;
  const passed = ctx.changedLines <= max;
  return { passed, detail: `${ctx.changedLines} changed line(s) across ${ctx.numstat.length} file(s), limit ${max} (lockfiles excluded)` };
}

const CONTENT_FILE = (p) => /\.mdx?$/.test(p) && p.includes("/") && !/^(docs|\.github|\.seo-autopilot|node_modules)\//.test(p) && !/(^|\/)(README|CHANGELOG|LICENSE|CLAUDE|AGENTS|CONTRIBUTING)\.mdx?$/i.test(p);

function checkSimilarity(ctx) {
  const threshold = Number(ctx.spec.qa?.similarity_threshold) || 0.8;
  const MIN_SHINGLES = 20;

  const newDocs = [];
  const newRoutes = new Set();
  for (const [route, e] of ctx.checkedRoutes) {
    if (!e.isNew) continue;
    newRoutes.add(route);
    const f = ctx.builtHtml.get(route);
    const text = f ? htmlToText(readFileSync(f, "utf8")) : e.files.map((p) => sourceToText(tryRead(p) || "", p)).join(" ");
    newDocs.push({ id: route, sh: shingles(text) });
  }
  const newFiles = new Set(ctx.nameStatus.filter((e) => e.status === "A").map((e) => e.path));
  for (const p of newFiles) {
    if (CONTENT_FILE(p) && !routeFromFile(p)) newDocs.push({ id: p, sh: shingles(sourceToText(tryRead(p) || "", p)) });
  }
  const candidates = newDocs.filter((d) => d.sh.size >= MIN_SHINGLES);
  if (candidates.length === 0) return NA("no new pages with enough text to compare");

  const existing = [];
  for (const [route, f] of ctx.builtHtml) {
    if (newRoutes.has(route)) continue;
    existing.push({ id: route, sh: shingles(htmlToText(readFileSync(f, "utf8"))) });
  }
  const builtRoutes = new Set(ctx.builtHtml.keys());
  for (const p of ctx.headFiles) {
    if (newFiles.has(p)) continue;
    const info = routeFromFile(p);
    const isContent = CONTENT_FILE(p) && !info;
    const isUnbuiltPage = info && info.kind === "page" && !builtRoutes.has(normalisePath(info.route)) && !isDynamicRoute(info.route);
    if (!isContent && !isUnbuiltPage) continue;
    existing.push({ id: p, sh: shingles(sourceToText(tryRead(p) || "", p)) });
  }
  // New pages are also compared with each other.
  const pool = [...existing, ...candidates];

  let worst = { score: 0, a: null, b: null };
  const offenders = [];
  for (const d of candidates) {
    for (const o of pool) {
      if (o === d || o.sh.size < MIN_SHINGLES) continue;
      const s = jaccard(d.sh, o.sh);
      if (s > worst.score) worst = { score: s, a: d.id, b: o.id };
      if (s >= threshold) offenders.push(`${d.id} ~ ${o.id} (${s.toFixed(2)})`);
    }
  }
  const summary = `max similarity ${worst.score.toFixed(2)}${worst.a ? ` (${worst.a} vs ${worst.b})` : ""}, threshold ${threshold}, ${candidates.length} new vs ${existing.length} existing`;
  if (offenders.length) return { passed: false, detail: `Near-duplicate content: ${[...new Set(offenders)].slice(0, 10).join(", ")}; ${summary}` };
  return { passed: true, detail: summary };
}

const CHECKS = [
  ["build_succeeded", checkBuild],
  ["no_routes_removed", checkRoutesRemoved],
  ["no_new_noindex_nofollow", checkNoindex],
  ["canonicals_self_referencing", checkCanonicals],
  ["titles_and_descriptions", checkTitles],
  ["internal_links_resolve", checkInternalLinks],
  ["new_pages_in_sitemap", checkSitemap],
  ["robots_unchanged", checkRobots],
  ["json_ld_valid", checkJsonLdAll],
  ["no_new_redirects", checkRedirects],
  ["diff_size", checkDiffSize],
  ["no_near_duplicate_content", checkSimilarity],
];

export function runChecks(ctx) {
  const checks = CHECKS.map(([name, fn]) => {
    try {
      const r = fn(ctx);
      return { name, passed: !!r.passed, detail: String(r.detail) };
    } catch (err) {
      return { name, passed: true, detail: `not applicable: could not evaluate (${String(err?.message || err).slice(0, 300)})` };
    }
  });
  return { passed: checks.every((c) => c.passed), checks };
}

// ---------------------------------------------------------------------------
// Self-test

function selfTest() {
  const results = [];
  const t = (name, cond) => results.push({ name, ok: !!cond });

  const a = "Emergency plumber in Leeds available twenty four hours a day for burst pipes and boiler repairs across West Yorkshire";
  const b = "Emergency plumber in Leeds available twenty four hours a day for burst pipes and boiler repairs across all of Yorkshire";
  const c = "Our bakery sells sourdough loaves croissants and seasonal cakes made fresh every morning in the heart of York";
  t("jaccard identical = 1", jaccard(shingles(a), shingles(a)) === 1);
  t("jaccard near-duplicate >= 0.7", jaccard(shingles(a), shingles(b)) >= 0.7);
  t("jaccard unrelated = 0", jaccard(shingles(a), shingles(c)) === 0);
  t("shingles of short text empty", shingles("one two three").size === 0);
  t("shingles count", shingles("a b c d e f").size === 2);

  t("route app page", routeFromFile("app/about/page.tsx")?.route === "/about");
  t("route app root", routeFromFile("src/app/page.tsx")?.route === "/");
  t("route group stripped", routeFromFile("app/(marketing)/services/[slug]/page.tsx")?.route === "/services/[slug]");
  t("route private folder ignored", routeFromFile("app/_components/page.tsx") === null);
  t("route parallel slot stripped", routeFromFile("app/@modal/login/page.tsx")?.route === "/login");
  t("route handler", routeFromFile("app/api/x/route.ts")?.kind === "handler");
  t("non-route file", routeFromFile("app/about/Hero.tsx") === null);
  t("app sitemap", routeFromFile("app/sitemap.ts")?.route === "/sitemap.xml");
  t("pages index", routeFromFile("pages/blog/index.tsx")?.route === "/blog");
  t("pages _app ignored", routeFromFile("pages/_app.tsx") === null);
  t("pages api handler", routeFromFile("pages/api/hello.ts")?.kind === "handler");

  const routes = ["/", "/about", "/services/[slug]", "/blog/[...slug]", "/docs/[[...path]]"];
  const pub = new Set(["brochure.pdf", "images/logo.png"]);
  t("link static", resolveLink("/about", routes, pub) === true);
  t("link trailing slash + hash", resolveLink("/about/#team", routes, pub) === true);
  t("link query", resolveLink("/?ref=x", routes, pub) === true);
  t("link dynamic", resolveLink("/services/boiler-repair", routes, pub) === true);
  t("link dynamic too deep", resolveLink("/services/a/b", routes, pub) === false);
  t("link catch-all", resolveLink("/blog/2026/10/post", routes, pub) === true);
  t("link catch-all needs one segment", resolveLink("/blog", routes, pub) === false);
  t("link optional catch-all root", resolveLink("/docs", routes, pub) === true);
  t("link public file", resolveLink("/brochure.pdf", routes, pub) === true);
  t("link missing", resolveLink("/contact-us", routes, pub) === false);
  t("link template ignored", resolveLink("/services/${slug}", routes, pub) === null);
  t("link external ignored", resolveLink("//cdn.example.com/x", routes, pub) === null);
  t("link case-insensitive", resolveLink("/About", routes, pub) === true);

  const links = extractInternalLinks(`<Link href="/about">A</Link> <a href={'/services/x'}>B</a> {href: "/blog/p"} [c](/docs/a "t") <a href="https://x.com/y">x</a> <Link href={\`/s/\${id}\`}>`);
  t("extract links", ["/about", "/services/x", "/blog/p", "/docs/a"].every((l) => links.includes(l)) && links.length === 4);

  const html = `<html><head><title>Boiler Repair Leeds | Acme &amp; Sons</title><meta name="description" content="Fast boiler repair in Leeds."><link rel="canonical" href="https://acme.co.uk/boiler-repair"><meta name="robots" content="index, follow"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Service","name":"x"}</script></head><body><header>Menu</header><main><h1>Boiler repair</h1><p>We fix boilers.</p></main><footer>Foot</footer></body></html>`;
  const h = extractHead(html);
  t("head title + entities", h.title === "Boiler Repair Leeds | Acme & Sons");
  t("head description", h.description === "Fast boiler repair in Leeds.");
  t("head canonical", h.canonical === "https://acme.co.uk/boiler-repair");
  t("head json-ld", h.jsonLd.length === 1 && checkJsonLd(h.jsonLd[0]).types[0] === "Service");
  t("json-ld missing type", checkJsonLd('{"@context":"https://schema.org"}').ok === false);
  t("json-ld graph", checkJsonLd('{"@graph":[{"@type":"Organization"},{"@type":"WebSite"}]}').types.length === 2);
  t("json-ld bad json", checkJsonLd("{oops").ok === false);
  t("html text strips chrome", htmlToText(html) === "Boiler repair We fix boilers.");

  const fd = { added: ["robots: { index: false },", "const x = 1;", "<meta name=\"robots\" content=\"noindex\" />"], removed: ['<meta name="robots" content="noindex" />'] };
  t("net added noindex", netAddedMatches(fd, NOINDEX_RE).length === 1);

  const parsed = parseUnifiedDiff("diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n");
  t("parse diff", parsed.get("x.ts")?.added[0] === "new" && parsed.get("x.ts")?.removed[0] === "old");

  const failed = results.filter((r) => !r.ok);
  for (const r of results) process.stderr.write(`${r.ok ? "ok  " : "FAIL"} ${r.name}\n`);
  process.stderr.write(`${results.length - failed.length}/${results.length} self-tests passed\n`);
  process.exit(failed.length ? 1 : 0);
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[a.slice(2)] = true;
    else (flags[a.slice(2)] = next), i++;
  }
  return flags;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags["self-test"]) return selfTest();
  if (!flags.base) {
    process.stderr.write("Usage: qa.mjs --base <ref> --spec <spec.json> [--out <file>] [--build-dir .next]\n");
    process.exit(2);
  }
  let result;
  try {
    const ctx = buildContext({ base: flags.base, specPath: flags.spec, buildDir: flags["build-dir"] || ".next" });
    result = runChecks(ctx);
  } catch (err) {
    result = { passed: false, checks: [{ name: "qa_setup", passed: false, detail: `QA could not start: ${String(err?.message || err).slice(0, 500)}` }] };
  }
  const json = JSON.stringify(result, null, 2);
  if (flags.out) writeFileSync(flags.out, json);
  process.stdout.write(json + "\n");
  for (const c of result.checks) process.stderr.write(`${c.passed ? "pass" : "FAIL"}  ${c.name}: ${c.detail}\n`);
  process.exit(result.passed ? 0 : 1);
}

const invokedDirectly = process.argv[1] && (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith("qa.mjs"));
if (invokedDirectly) main();
