// Local search tracking (§9.4): which Google searches to track for a client, and how to read the
// results. Pure functions; the provider fetches, these decide.

export type TrackedQuery = { query: string; service: string; location: string };

const clean = (s: string) => s.trim().replace(/\s+/g, " ");

/**
 * Priority services × served towns (primary town first), e.g. "boiler repair exeter". Falls back to
 * all services when no priorities are set. Excluded services and towns are never tracked.
 */
export function trackedQueries(
  c: { services: string[]; priorityServices: string[]; locations: string[]; primaryLocation: string; excludedServices: string[]; excludedLocations: string[] },
  cap: number,
): TrackedQuery[] {
  const low = (xs: string[]) => new Set(xs.map((x) => clean(x).toLowerCase()));
  const exS = low(c.excludedServices);
  const exL = low(c.excludedLocations);
  const services = [...new Set((c.priorityServices.length ? c.priorityServices : c.services).map(clean))].filter((s) => s && !exS.has(s.toLowerCase()));
  const locations = [...new Set([c.primaryLocation, ...c.locations].map(clean))].filter((l) => l && !exL.has(l.toLowerCase()));
  const out: TrackedQuery[] = [];
  // Town by town, so the primary town is fully covered before the cap bites.
  for (const location of locations) {
    for (const service of services) {
      if (out.length >= cap) return out;
      out.push({ query: `${service} ${location}`.toLowerCase(), service, location });
    }
  }
  return out;
}

/** "www.Example.co.uk" → "example.co.uk" */
export function bareDomain(d: string | null | undefined): string {
  return (d ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

export function isClientDomain(domain: string | null | undefined, clientDomain: string): boolean {
  const d = bareDomain(domain);
  const c = bareDomain(clientDomain);
  return !!d && (d === c || d.endsWith(`.${c}`));
}

// Directories and platforms that rank everywhere; they aren't the client's competitors.
const DIRECTORIES = [
  "yell.com", "checkatrade.com", "trustatrader.com", "mybuilder.com", "ratedpeople.com", "bark.com", "facebook.com", "instagram.com",
  "linkedin.com", "yelp.co.uk", "yelp.com", "thomsonlocal.com", "freeindex.co.uk", "trustpilot.com", "google.com", "youtube.com",
  "reddit.com", "wikipedia.org", "gov.uk", "nhs.uk", "which.co.uk", "houzz.co.uk", "tripadvisor.co.uk", "nextdoor.co.uk",
];
export function isDirectory(domain: string): boolean {
  const d = bareDomain(domain);
  return DIRECTORIES.some((x) => d === x || d.endsWith(`.${x}`));
}

export type SerpResult = {
  query: string;
  service: string;
  location: string;
  /** Client's best organic position (1-based), null if not in the results fetched. */
  organicPosition: number | null;
  organicUrl: string | null;
  /** Client's position in the Google Maps results, null if not found. */
  localPosition: number | null;
  /** Top organic domains, in order. */
  organic: { position: number; domain: string; url: string; title: string }[];
  /** Top map results, in order. */
  local: { position: number; title: string; domain: string | null; rating: number | null }[];
};

/** Domains that keep appearing in the top 10 across the client's tracked searches. */
export function competitors(results: SerpResult[], clientDomain: string, limit = 10): { domain: string; appearances: number; bestPosition: number }[] {
  const by = new Map<string, { appearances: number; bestPosition: number }>();
  for (const r of results) {
    const seen = new Set<string>();
    for (const o of r.organic.filter((x) => x.position <= 10)) {
      const d = bareDomain(o.domain);
      if (!d || seen.has(d) || isClientDomain(d, clientDomain) || isDirectory(d)) continue;
      seen.add(d);
      const e = by.get(d) ?? { appearances: 0, bestPosition: 99 };
      e.appearances++;
      e.bestPosition = Math.min(e.bestPosition, o.position);
      by.set(d, e);
    }
  }
  return [...by.entries()]
    .filter(([, e]) => e.appearances >= 2)
    .map(([domain, e]) => ({ domain, ...e }))
    .sort((a, b) => b.appearances - a.appearances || a.bestPosition - b.bestPosition)
    .slice(0, limit);
}

/** Position change between two snapshots; positive = moved up. Null when either is missing. */
export function positionChange(now: number | null, before: number | null): number | null {
  if (now == null || before == null) return null;
  return before - now;
}
