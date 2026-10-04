import { createServer, type Server } from "node:http";

// A stand-in for SiteGuru's MCP server, with payloads copied from real responses (trimmed).
export const OVERVIEW_30D = {
  status: "ok",
  data_period: { start: "2026-09-02", end: "2026-10-01" },
  search_console: {
    status: "ok",
    clicks: { value: 2816, previous: 2997, delta_pct: -6 },
    impressions: { value: 313112, previous: 340027, delta_pct: -7.9 },
    ctr: { value: 0.9, previous: 0.88, delta_pct: 2 },
  },
  analytics: { status: "ok", sessions: { value: 12233, previous: 13452, delta_pct: -9.1 } },
  top_pages: [
    { path: "/", url: "https://www.projuice.co.uk/", clicks: 603, impressions: 5919, avg_position: 26 },
    { path: "/product-category/frozen-fruits/", clicks: 109, impressions: 7867, avg_position: 7 },
  ],
};

export const KEYWORDS_30D = {
  status: "ok",
  keywords: [
    { keyword: "projuice", clicks: { value: 405, previous: 347 }, avg_position: { value: 1.3, previous: 1.3, change: -0.1 } },
    { keyword: "frozen fruit", clicks: { value: 20, previous: 29 }, avg_position: { value: 6.1, previous: 7.3, change: -1.2 } },
    { keyword: "frozen mango chunks", clicks: { value: 6, previous: 0 }, avg_position: { value: 6.3, previous: 0, change: 6.3 } },
  ],
};

export const SITES = {
  sites: [
    { domain: "https://www.projuice.co.uk", health_score: 89, data_sources: { search_console: { connected: true }, analytics: { connected: true } } },
    { domain: "https://www.devonjoinery.co.uk", health_score: 92, data_sources: { search_console: { connected: false }, analytics: { connected: true } } },
  ],
};

type Opts = { sse?: boolean; key?: string; summaryPrefix?: boolean; failTool?: string };

export async function startMockMcp(opts: Opts = {}): Promise<{ url: string; calls: { name: string; args: Record<string, unknown> }[]; close: () => Promise<void> }> {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const server: Server = createServer(async (req, res) => {
    if ((req.headers.authorization ?? "") !== `Bearer ${opts.key ?? "test-key"}`) {
      res.writeHead(401);
      return res.end("unauthorised");
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const msg = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (msg.id === undefined) {
      res.writeHead(202);
      return res.end();
    }
    let result: unknown;
    if (msg.method === "initialize") {
      result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1" } };
    } else if (msg.method === "tools/call") {
      const name = msg.params!.name!;
      const args = msg.params!.arguments ?? {};
      calls.push({ name, args });
      let data: unknown;
      if (name === opts.failTool) {
        result = { isError: true, content: [{ type: "text", text: "boom" }] };
      } else {
        if (name === "list_sites") data = SITES;
        else if (name === "get_top_keywords") data = KEYWORDS_30D;
        else if (name === "get_traffic_overview") {
          // Only last_30_days and September 2026 are "cached"; anything else is empty.
          if (args.range === "last_30_days") data = OVERVIEW_30D;
          else if (args.start === "2026-09-01")
            data = { status: "ok", search_console: { status: "ok", clicks: { value: 2900 }, impressions: { value: 320000 } } };
          else data = { status: "empty", message: "not cached" };
        }
        const text = (opts.summaryPrefix ? "Here is the data.\n\n" : "") + JSON.stringify(data);
        result = { content: [{ type: "text", text }] };
      }
    }
    const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
    if (opts.sse) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Mcp-Session-Id": "sess-1" });
      res.end(`event: message\ndata: ${payload}\n\n`);
    } else {
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "sess-1" });
      res.end(payload);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}/mcp`, calls, close: () => new Promise((r) => server.close(() => r())) };
}
