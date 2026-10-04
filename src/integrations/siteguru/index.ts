import "server-only";
import { getProviderKey } from "../keys";
import { McpClient, toolJson } from "../mcp/client";
import { callProvider, IntegrationError } from "../run";
import { listSitesSchema, topKeywordsSchema, trafficOverviewSchema, type SiteguruSiteRaw, type TopKeywords, type TrafficOverview } from "./schemas";

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
};
