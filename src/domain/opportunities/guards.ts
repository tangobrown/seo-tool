import type { Candidate, DetectionInput } from "./types";

/**
 * Strategy guards (§10.5 step 1): drop anything touching an excluded service or location, and
 * new pages for services/locations that aren't on the client's lists.
 */
export function violatesStrategy(c: Pick<Candidate, "type" | "title" | "targetQuery" | "targetUrl" | "service" | "location">, client: DetectionInput["client"]): string | null {
  const text = [c.title, c.targetQuery, c.targetUrl, c.service, c.location].filter(Boolean).join(" ").toLowerCase();
  const hit = (terms: string[]) => terms.find((t) => t.trim() && text.includes(t.trim().toLowerCase()));
  const s = hit(client.excludedServices);
  if (s) return `Excluded service: ${s}`;
  const l = hit(client.excludedLocations);
  if (l) return `Excluded location: ${l}`;
  if (c.type === "new_service_page" && c.service && !client.services.includes(c.service)) return "Service not on the client’s list";
  if (c.type === "new_location_page" && c.location && !client.locations.includes(c.location)) return "Location not on the client’s list";
  return null;
}

/** Safety rules (§10.5): these actions are never automatic; they always become a manual checklist. */
const ALWAYS_MANUAL = /\b(delete|remove the page|redirect(s)? (from|to)|add (a )?redirect|robots\.txt|change (the )?domain|primary category|business name|phone number|address)\b/i;

export function forceManualIfUnsafe<T extends Pick<Candidate, "proposedAction" | "executionType" | "riskLabel">>(c: T): T {
  if (c.executionType !== "manual_action" && ALWAYS_MANUAL.test(c.proposedAction.replace(/no (pages are|redirects are)[^.]*\./gi, ""))) {
    return { ...c, executionType: "manual_action", riskLabel: "high" };
  }
  return c;
}
