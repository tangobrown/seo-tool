import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkWebsite, crawlSite } from "@/integrations/website";

const pages: Record<string, string> = {
  "/": `<title>Exeter Heating</title><h1>Heating engineers in Exeter</h1><a href="/boiler-repair">Boilers</a><a href="/areas/exmouth">Exmouth</a>`,
  "/boiler-repair": `<title>Boiler repair</title><h1>Boiler repair</h1><a href="/">Home</a><a href="/contact">Contact</a>`,
  "/areas/exmouth": `<title>Exmouth</title><h1>Heating in Exmouth</h1><meta name="robots" content="noindex">`,
  "/contact": `<title>Contact</title><h1>Contact us</h1>`,
};

let server: Server;
let origin = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/old") {
      res.writeHead(301, { Location: "/" });
      return res.end();
    }
    if (req.url === "/sitemap.xml") {
      res.writeHead(200, { "Content-Type": "application/xml" });
      return res.end(`<urlset><url><loc>${origin}/</loc></url><url><loc>${origin}/boiler-repair</loc></url></urlset>`);
    }
    const body = pages[req.url ?? ""];
    if (!body) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><head></head><body>${body}</body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("website integration", () => {
  it("follows redirects when checking reachability", async () => {
    const r = await checkWebsite(`${origin}/old`);
    expect(r.ok).toBe(true);
    expect(r.finalUrl).toBe(`${origin}/`);
  });
  it("crawls the sitemap first, then internal links", async () => {
    const { pages: got, fromSitemap } = await crawlSite(origin, { maxPages: 50 });
    expect(fromSitemap).toBe(2);
    const paths = got.map((p) => p.path).sort();
    expect(paths).toEqual(["/", "/areas/exmouth", "/boiler-repair", "/contact"]);
    expect(got.find((p) => p.path === "/areas/exmouth")?.noindex).toBe(true);
  });
  it("respects the page cap", async () => {
    const { pages: got } = await crawlSite(origin, { maxPages: 2 });
    expect(got.length).toBeLessThanOrEqual(2);
  });
});
