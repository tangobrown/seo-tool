// toSerpResult lives in a server module; stub its server-only imports.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));

describe("matching the client in Google results", async () => {
  const { toSerpResult } = await import("@/server/dataforseo-runs");
  const q = { query: "boiler repair exeter", service: "Boiler repair", location: "Exeter" };

  it("finds the client's organic and map positions by domain, or by exact business name", () => {
    const r = toSerpResult(
      q,
      { domain: "exeterheating.co.uk", name: "Exeter Heating" },
      [
        { type: "local_pack", rank_group: 1, domain: "rival.co.uk", title: "Rival" },
        { type: "organic", rank_group: 2, domain: "www.exeterheating.co.uk", url: "https://www.exeterheating.co.uk/boiler-repair/", title: "Boiler repair" },
        { type: "organic", rank_group: 1, domain: "rival.co.uk", url: "https://rival.co.uk/", title: "Rival" },
      ],
      [
        { type: "maps_search", rank_group: 2, domain: null, title: "Exeter Heating", rating: { value: 4.9 } },
        { type: "maps_search", rank_group: 1, domain: "rival.co.uk", title: "Rival Heating", rating: { value: 4.7 } },
        { type: "maps_paid_item", rank_group: 0, domain: "ad.co.uk", title: "Ad" },
      ],
    );
    expect(r.organicPosition).toBe(2);
    expect(r.organicUrl).toBe("https://www.exeterheating.co.uk/boiler-repair/");
    expect(r.organic.map((o) => o.domain)).toEqual(["rival.co.uk", "exeterheating.co.uk"]);
    expect(r.localPosition).toBe(2);
    expect(r.local).toHaveLength(2); // paid listing left out
  });

  it("reports not found as null, never a guess", () => {
    const r = toSerpResult(q, { domain: "exeterheating.co.uk", name: "Exeter Heating" }, [], [{ type: "maps_search", rank_group: 1, title: "Exeter Heating Supplies Ltd", domain: "other.co.uk" }]);
    expect(r.organicPosition).toBeNull();
    expect(r.localPosition).toBeNull();
  });
});
