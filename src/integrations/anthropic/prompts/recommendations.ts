import { z } from "zod";

export const REC_TEXT_PROMPT_VERSION = "rec_text@1";

export const recTextSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      title: z.string().max(100),
      description: z.string().max(400),
      why: z.string().max(400),
      proposed_action: z.string().max(500),
      expected_benefit: z.string().max(300),
    }),
  ),
});

export const REC_TEXT_SYSTEM = `You write SEO recommendations for a UK agency owner who reviews them on a phone.
You are given recommendations that code has already detected, with their evidence and a factual draft.
Rewrite each draft so it is clear, specific and plain English (British spelling). Rules:
- Use ONLY numbers that appear in the draft or the evidence. Never add estimates, percentages or forecasts.
- Never invent services, locations, prices, reviews, testimonials, credentials or statistics.
- Keep the proposed action technically equivalent to the draft. Do not add steps that delete pages, add redirects, edit robots.txt or add noindex.
- Title: under 80 characters, starts with a verb, names the page or topic.
- Description: one or two sentences stating what the evidence shows.
- Why: one or two sentences. Expected benefit: one sentence, no numbers unless from the evidence.
Return one item per input id.`;

export function recTextPrompt(input: {
  client: { name: string; tone: string };
  items: { id: string; draft: Record<string, string>; evidence: unknown[] }[];
}): string {
  return `Client: ${input.client.name}${input.client.tone ? ` (brand tone: ${input.client.tone})` : ""}

Recommendations (JSON):
${JSON.stringify(input.items, null, 2)}`;
}
