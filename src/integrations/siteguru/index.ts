import "server-only";
import { getProviderKey } from "../keys";
import { McpClient, toolJson } from "../mcp/client";
import { callProvider, IntegrationError } from "../run";
import {
  cannibalizationSchema,
  decliningSchema,
  listSitesSchema,
  lowHangingFruitSchema,
  todoListSchema,
  topKeywordsSchema,
  trafficOverviewSchema,
  type Cannibalization,
  type Declining,
  type LowHangingFruit,
  type SiteguruSiteRaw,
  type TodoList,
  type TopKeywords,
  type TrafficOverview,
} from "./schemas";

export const SITEGURU_MCP_URL = process.env.SITEGURU_MCP_URL || "https://mcp.siteguru.co/mcp";
const CONTEXT = "SEO Autopilot scheduled sync for an agency client";

type Period = { range: string } | { start: string; end: string };

async function client(): Promise<McpClient> {
  const key = await getProviderKey("siteguru");
  if (!key) throw new IntegrationError("siteguru", "No SiteGuru API key. Add one in Settings → Integrations.", false);
  return new McpClient("siteguru", SITEGURU_MCP_URL, key);
}

export async function siteguruConfigured(): Promise<boolean> {
  return !!(await getProviderKey("siteguru"));
}

/** SEODataProvider over SiteGuru's MCP server (Bearer API key). */
export const siteguru = {
  async listSites(): Promise<SiteguruSiteRaw[]> {
    const c = await client();
    return callProvider("siteguru", "list_sites", async (signal) => {
      const out = listSitesSchema.parse(toolJson(await c.callTool("list_sites", { context: CONTEXT }, signal)));
      return out.sites;
    });
  },

  async trafficOverview(site: string, period: Period): Promise<TrafficOverview> {
    const c = await client();
    return callProvider("siteguru", "get_traffic_overview", async (signal) =>
      trafficOverviewSchema.parse(toolJson(await c.callTool("get_traffic_overview", { site, ...period, context: CONTEXT }, signal))),
    );
  },

  async topKeywords(site: string, period: Period): Promise<TopKeywords> {
    const c = await client();
    return callProvider("siteguru", "get_top_keywords", async (signal) =>
      topKeywordsSchema.parse(toolJson(await c.callTool("get_top_keywords", { site, ...period, context: CONTEXT }, signal))),
    );
  },

  async todoList(site: string): Promise<TodoList> {
    const c = await client();
    return callProvider("siteguru", "get_todo_list", async (signal) =>
      todoListSchema.parse(toolJson(await c.callTool("get_todo_list", { site, context: CONTEXT }, signal))),
    );
  },

  async lowHangingFruit(site: string, period: Period): Promise<LowHangingFruit> {
    const c = await client();
    return callProvider("siteguru", "get_low_hanging_fruit", async (signal) =>
      lowHangingFruitSchema.parse(toolJson(await c.callTool("get_low_hanging_fruit", { site, ...period, context: CONTEXT }, signal))),
    );
  },

  async decliningContent(site: string): Promise<Declining> {
    const c = await client();
    return callProvider("siteguru", "get_declining_content", async (signal) =>
      decliningSchema.parse(toolJson(await c.callTool("get_declining_content", { site, context: CONTEXT }, signal))),
    );
  },

  async cannibalization(site: string, period: Period): Promise<Cannibalization> {
    const c = await client();
    return callProvider("siteguru", "get_keyword_cannibalization", async (signal) =>
      cannibalizationSchema.parse(toolJson(await c.callTool("get_keyword_cannibalization", { site, ...period, context: CONTEXT }, signal))),
    );
  },
};
