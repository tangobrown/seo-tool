import { z } from "zod";

export const BLOG_PROMPT_VERSION = "blog@1";

export const blogPlanSchema = z.object({
  topics: z.array(
    z.object({
      keyword: z.string(),
      title: z.string().max(90),
      angle: z.string().max(300),
    }),
  ),
});

export const BLOG_PLAN_SYSTEM = `You plan blog posts for a UK small business's website.
You are given search queries real people used to find the site (with impressions), plus the business's services and areas.
Pick the requested number of topics. Rules:
- Each topic must be based on exactly one of the given keywords; copy that keyword unchanged into "keyword".
- Choose topics that help a potential customer and relate to the business's own services and areas.
- Never cover excluded services or areas. Never invent services, locations, prices or statistics.
- Title: under 70 characters, British English, no clickbait. Angle: one or two sentences on what the post will cover.
- Never pick two topics that would answer the same question.`;

export function blogPlanPrompt(input: {
  client: { name: string; industry: string; services: string[]; locations: string[]; excluded: string[] };
  count: number;
  keywords: { keyword: string; impressions: number }[];
  existingTitles: string[];
}): string {
  return `Business: ${input.client.name}${input.client.industry ? ` (${input.client.industry})` : ""}
Services: ${input.client.services.join(", ") || "—"}
Areas served: ${input.client.locations.join(", ") || "—"}
Excluded: ${input.client.excluded.join(", ") || "none"}
Topics needed: ${input.count}

Keywords (JSON):
${JSON.stringify(input.keywords, null, 2)}

Existing page titles (don't duplicate):
${input.existingTitles.slice(0, 80).join("\n")}`;
}

export const blogDraftSchema = z.object({
  title: z.string().max(90),
  slug: z.string().max(80),
  meta_description: z.string().max(160),
  body_markdown: z.string(),
});

export const BLOG_DRAFT_SYSTEM = `You write blog posts for UK small-business websites. Rules:
- British English. Helpful, plain, specific. Written for a potential customer, not for search engines.
- 700 to 1,100 words of Markdown. Use ## and ### headings and short paragraphs. No H1 (the title is separate).
- Use the target keyword naturally in the title, the first paragraph and one heading. Don't repeat it more than that.
- Mention ONLY the business's own services and areas. Never mention excluded services or areas.
- NEVER include: testimonials, reviews, quotes from customers, awards, accreditations, qualifications, memberships, guarantees, "leading" or "number one" claims, prices, statistics or any figure you weren't given.
- End with a short, friendly call to action to contact the business. No phone numbers, emails or addresses.
- slug: lowercase words separated by hyphens. meta_description: under 155 characters.`;

export function blogDraftPrompt(input: {
  client: { name: string; tone: string; services: string[]; locations: string[]; excluded: string[] };
  topic: { title: string; keyword: string; angle: string };
  retryReasons?: string[];
}): string {
  return `Business: ${input.client.name}${input.client.tone ? ` (tone: ${input.client.tone})` : ""}
Services: ${input.client.services.join(", ") || "—"}
Areas served: ${input.client.locations.join(", ") || "—"}
Excluded (never mention): ${input.client.excluded.join(", ") || "none"}

Post title: ${input.topic.title}
Target keyword: ${input.topic.keyword}
Angle: ${input.topic.angle}${
    input.retryReasons?.length ? `\n\nA previous draft was rejected for these reasons. Fix every one:\n- ${input.retryReasons.join("\n- ")}` : ""
  }`;
}
