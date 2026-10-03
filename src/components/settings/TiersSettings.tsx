"use client";

import { useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { useDebouncedSave } from "@/components/ui/useAutosave";
import { propertyInputClass } from "@/components/ui/PropertyRow";
import { updateTierField } from "@/server/actions/settings";

type TierRow = { id: string; name: string; postsPerMonth: number; scanFrequency: string; pricePence: number; clients: number };

export function TiersSettings({ tiers }: { tiers: TierRow[] }) {
  return (
    <div>
      <p className="mb-3 text-[13px] text-muted">Changes apply to every client on that tier from the next cycle.</p>
      <div className="hidden grid-cols-4 gap-3 border-b border-line px-1.5 py-2 text-[12px] text-subtle-2 md:grid">
        <div>Tier</div>
        <div>Blog posts / month</div>
        <div>Site scans</div>
        <div>Price / month</div>
      </div>
      {tiers.map((t) => (
        <TierEditor key={t.id} t={t} />
      ))}
    </div>
  );
}

function TierEditor({ t }: { t: TierRow }) {
  const toast = useToast();
  const [posts, setPosts] = useState(String(t.postsPerMonth));
  const [price, setPrice] = useState(String(t.pricePence / 100));
  const [scan, setScan] = useState(t.scanFrequency);
  const save = async (field: "postsPerMonth" | "scanFrequency" | "pricePence", value: unknown) => {
    const r = await updateTierField(t.id, field, value);
    if (!r.ok) toast({ message: r.error });
  };
  const savePosts = useDebouncedSave((v: string) => save("postsPerMonth", v));
  const savePrice = useDebouncedSave((v: string) => save("pricePence", Math.round(Number(v.replace(/[£,]/g, "")) * 100)));

  const inputs = {
    posts: <input className={propertyInputClass} value={posts} inputMode="numeric" aria-label={`${t.name} blog posts per month`} onChange={(e) => (setPosts(e.target.value), savePosts(e.target.value))} />,
    scan: (
      <select className={propertyInputClass} value={scan} aria-label={`${t.name} site scans`} onChange={(e) => (setScan(e.target.value), void save("scanFrequency", e.target.value))}>
        <option value="monthly">Monthly</option>
        <option value="fortnightly">Fortnightly</option>
        <option value="weekly">Weekly</option>
      </select>
    ),
    price: (
      <div className="flex items-center">
        <span className="text-muted">£</span>
        <input className={propertyInputClass} value={price} inputMode="decimal" aria-label={`${t.name} price per month`} onChange={(e) => (setPrice(e.target.value), savePrice(e.target.value))} />
      </div>
    ),
  };

  return (
    <>
      {/* Desktop row */}
      <div className="hidden grid-cols-4 items-center gap-3 border-b border-line px-1.5 py-1.5 md:grid">
        <div>
          <span className="font-medium">{t.name}</span> <span className="text-[13px] text-subtle-2">({t.clients} client{t.clients === 1 ? "" : "s"})</span>
        </div>
        {inputs.posts}
        {inputs.scan}
        {inputs.price}
      </div>
      {/* Mobile card */}
      <div className="mb-3 rounded-lg border border-line p-3.5 md:hidden">
        <div className="mb-2 font-semibold">
          {t.name} <span className="text-[13px] font-normal text-subtle-2">· {t.clients} client{t.clients === 1 ? "" : "s"}</span>
        </div>
        <label className="block text-[13px] text-muted">Blog posts / month{inputs.posts}</label>
        <label className="mt-2 block text-[13px] text-muted">Site scans{inputs.scan}</label>
        <label className="mt-2 block text-[13px] text-muted">Price / month{inputs.price}</label>
      </div>
    </>
  );
}
