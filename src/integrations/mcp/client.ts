import "server-only";
import { IntegrationError } from "../run";

/**
 * Minimal MCP client over Streamable HTTP (JSON-RPC 2.0 via POST), enough to call tools on a remote
 * server with a Bearer key. Handles both plain JSON and text/event-stream responses. No SDK dependency.
 */

type JsonRpcResponse = { jsonrpc: "2.0"; id?: number | string; result?: unknown; error?: { code: number; message: string } };

export type McpToolResult = {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
};

const PROTOCOL_VERSION = "2025-06-18";

async function readRpc(res: Response, id: number): Promise<JsonRpcResponse | null> {
  const type = res.headers.get("content-type") ?? "";
  const body = await res.text();
  if (!body.trim()) return null;
  if (type.includes("text/event-stream")) {
    // Each SSE event carries one JSON-RPC message in its data lines; pick the response to our id.
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        const msg = JSON.parse(data) as JsonRpcResponse;
        if (msg.id === id) return msg;
      } catch {
        /* skip non-JSON events */
      }
    }
    return null;
  }
  return JSON.parse(body) as JsonRpcResponse;
}

export class McpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private initialised = false;

  constructor(
    private readonly provider: string,
    private readonly url: string,
    private readonly apiKey: string,
  ) {}

  private async post(payload: object, signal?: AbortSignal): Promise<Response> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${this.apiKey}`,
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      },
      body: JSON.stringify(payload),
      signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new IntegrationError(this.provider, `${this.provider} rejected the API key (HTTP ${res.status})`, false);
    }
    if (!res.ok && res.status !== 202) {
      const text = await res.text().catch(() => "");
      throw new IntegrationError(this.provider, `${this.provider} MCP HTTP ${res.status}: ${text.slice(0, 200)}`, res.status >= 500 || res.status === 429);
    }
    return res;
  }

  private async request(method: string, params: object, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params }, signal);
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    const msg = await readRpc(res, id);
    if (!msg) throw new IntegrationError(this.provider, `${this.provider} MCP: empty response to ${method}`);
    if (msg.error) throw new IntegrationError(this.provider, `${this.provider} MCP error ${msg.error.code}: ${msg.error.message}`, false);
    return msg.result;
  }

  private async ensureInitialised(signal?: AbortSignal) {
    if (this.initialised) return;
    await this.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "seo-autopilot", version: "1.0.0" } },
      signal,
    );
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, signal);
    this.initialised = true;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    await this.ensureInitialised(signal);
    const result = (await this.request("tools/call", { name, arguments: args }, signal)) as McpToolResult;
    if (result?.isError) {
      const text = result.content?.find((c) => c.type === "text")?.text ?? "tool error";
      throw new IntegrationError(this.provider, `${this.provider} ${name}: ${text.slice(0, 300)}`, false);
    }
    return result;
  }
}

/**
 * A tool result's data: structuredContent when present, otherwise the JSON in the text content
 * (some servers prefix it with a short summary).
 */
export function toolJson(result: McpToolResult): unknown {
  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent;
  const text = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  try {
    return JSON.parse(text);
  } catch {
    const start = text.search(/[{[]/);
    if (start === -1) throw new Error("No JSON in tool result");
    return JSON.parse(text.slice(start));
  }
}
