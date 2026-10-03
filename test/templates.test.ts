import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderTemplatesModule } from "../scripts/embed-templates";

describe("client repo templates", () => {
  it("embedded module is up to date (run pnpm templates)", () => {
    expect(readFileSync("src/integrations/github/templates.generated.ts", "utf8")).toBe(renderTemplatesModule());
  });
});
