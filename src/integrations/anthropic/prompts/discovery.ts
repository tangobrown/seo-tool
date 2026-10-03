import { z } from "zod";

export const DISCOVERY_PROMPT_VERSION = "discovery@1";

export const pageTypeSchema = z.object({
  pages: z.array(
    z.object({
      path: z.string(),
      page_type: z.enum(["homepage", "service", "location", "service_location", "blog", "about", "contact", "other"]),
      service: z.string().nullable(),
      location: z.string().nullable(),
      commercial_intent: z.boolean(),
    }),
  ),
});

export const discoverySchema = z.object({
  industry: z.string(),
  primary_location: z.string(),
  services: z.array(z.string()),
  locations: z.array(z.string()),
});

export const DISCOVERY_SYSTEM = `You analyse UK small-business websites for an SEO agency.
Only report what the supplied page data shows. Never invent services or locations that are not evidenced in the titles, headings, paths or text provided.
Use short, plain service names a customer would search for (e.g. "Boiler repair", not "Our boiler repair services").
Locations are towns, cities or areas the business says it serves. Use British spelling.`;

export function classifyPrompt(pages: { path: string; title: string | null; h1: string | null }[]): string {
  return `Classify each page of this website by type. For service or location pages, name the service and/or location it targets.
Return one entry per input page, using the same path.

Pages (path | title | h1):
${pages.map((p) => `${p.path} | ${p.title ?? ""} | ${p.h1 ?? ""}`).join("\n")}`;
}

export function discoveryPrompt(input: { domain: string; homepageText: string; pages: { path: string; title: string | null; h1: string | null }[] }): string {
  return `Website: ${input.domain}

Find the services this business offers and the locations it serves, plus its industry and primary location.
List at most 15 services and 15 locations, most important first.

Homepage text (truncated):
${input.homepageText.slice(0, 6000)}

Pages (path | title | h1):
${input.pages
  .slice(0, 300)
  .map((p) => `${p.path} | ${p.title ?? ""} | ${p.h1 ?? ""}`)
  .join("\n")}`;
}
