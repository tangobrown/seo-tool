import { describe, expect, it } from "vitest";
import { McpClient, toolJson } from "@/integrations/mcp/client";
import { startMockMcp } from "./helpers/mock-mcp";

describe("MCP client", () => {
  for (const sse of [false, true]) {
    it(`calls tools over ${sse ? "SSE" : "JSON"} responses`, async () => {
      const mock = await startMockMcp({ sse });
      try {
        const c = new McpClient("siteguru", mock.url, "test-key");
        const data = toolJson(await c.callTool("list_sites", {})) as { sites: unknown[] };
        expect(data.sites).toHaveLength(2);
        await c.callTool("get_traffic_overview", { site: "x", range: "last_30_days" });
        expect(mock.calls.map((x) => x.name)).toEqual(["list_sites", "get_traffic_overview"]);
      } finally {
        await mock.close();
      }
    });
  }

  it("reads JSON that follows a text summary", async () => {
    const mock = await startMockMcp({ summaryPrefix: true });
    try {
      const data = toolJson(await new McpClient("siteguru", mock.url, "test-key").callTool("list_sites", {})) as { sites: unknown[] };
      expect(data.sites).toHaveLength(2);
    } finally {
      await mock.close();
    }
  });

  it("fails clearly on a bad key and on tool errors", async () => {
    const mock = await startMockMcp({ failTool: "get_top_keywords" });
    try {
      await expect(new McpClient("siteguru", mock.url, "wrong").callTool("list_sites", {})).rejects.toThrow(/rejected the API key/);
      await expect(new McpClient("siteguru", mock.url, "test-key").callTool("get_top_keywords", {})).rejects.toThrow(/boom/);
    } finally {
      await mock.close();
    }
  });
});
