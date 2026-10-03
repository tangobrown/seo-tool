import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { callProvider, IntegrationError } from "../run";

export function anthropicConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

const model = () => process.env.ANTHROPIC_MODEL || "claude-opus-5-5";

let client: Anthropic | null = null;
function getClient() {
  client ??= new Anthropic();
  return client;
}

/**
 * Structured JSON from Claude, validated with Zod. Retries once on a validation failure,
 * then fails visibly (§9.6). Never used as a source of numbers or facts.
 */
export async function llmJson<S extends z.ZodType>(input: {
  schema: S;
  schemaName: string;
  system: string;
  prompt: string;
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
}): Promise<z.infer<S>> {
  if (!anthropicConfigured()) throw new IntegrationError("anthropic", "ANTHROPIC_API_KEY is not set", false);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await callProvider(
        "anthropic",
        input.schemaName,
        async (signal) => {
          const res = await getClient().beta.messages.parse(
            {
              model: model(),
              max_tokens: input.maxTokens ?? 16000,
              betas: ["server-side-fallback-2026-07-01"],
              fallbacks: "default",
              system: input.system,
              output_config: { effort: input.effort ?? "low", format: zodOutputFormat(input.schema) },
              messages: [{ role: "user", content: input.prompt }],
            },
            { signal },
          );
          if (res.stop_reason === "refusal") throw new IntegrationError("anthropic", "The model declined this request", false);
          if (res.parsed_output == null) throw new IntegrationError("anthropic", `${input.schemaName}: response did not match the schema`, false);
          return input.schema.parse(res.parsed_output) as z.infer<S>;
        },
        { timeoutMs: 180_000, retries: 1 },
      );
    } catch (e) {
      lastErr = e;
      // Only a validation failure earns the one extra attempt.
      if (!(e instanceof IntegrationError && e.message.includes("did not match"))) break;
    }
  }
  throw lastErr;
}
