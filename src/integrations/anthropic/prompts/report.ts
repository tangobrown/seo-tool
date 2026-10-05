import { z } from "zod";

export const REPORT_PROMPT_VERSION = "report@1";

export const reportTextSchema = z.object({
  summary: z.string().max(700),
  what_we_did: z.array(z.string().max(160)).max(8),
  next_month: z.array(z.string().max(160)).max(5),
});

export const REPORT_SYSTEM = `You write a short monthly SEO update that a UK agency sends to a small-business owner.
You are given facts that code has already computed: a factual summary, the work completed and the work planned.
Rewrite them for a business owner who isn't technical. Rules:
- British English. Positive, confident, plain English. No jargon (no "meta", "schema", "canonical", "CTR", "SERP").
- Use ONLY numbers that appear in the facts. Never add estimates, forecasts or percentages of your own.
- Never hide or spin a decline. If the facts show a drop, say so plainly, give the context from the facts and say what is being done about it.
- Never invent work, results, services, locations, reviews or credentials.
- Summary: two to four sentences.
- What we did: one bullet per completed item, same order, each under 15 words, e.g. "Created a new Emergency Plumbing page".
- Next month: one bullet per planned item, same order, each under 15 words.`;

export function reportPrompt(input: {
  client: { name: string; tone: string };
  periodLabel: string;
  facts: { summary: string; performance: string[]; work: string[]; next: string[] };
}): string {
  return `Client: ${input.client.name}${input.client.tone ? ` (brand tone: ${input.client.tone})` : ""}
Month: ${input.periodLabel}

Facts (JSON):
${JSON.stringify(input.facts, null, 2)}`;
}
