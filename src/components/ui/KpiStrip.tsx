import { cx } from "./cx";

export type Kpi = { label: string; value: string; delta?: { text: string; good: boolean } | null };

export function KpiStrip({ items }: { items: Kpi[] }) {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-4">
      {items.map((k) => (
        <div key={k.label} className="bg-white px-4 py-3.5">
          <div className="text-[12px] text-muted">{k.label}</div>
          <div className="text-[24px] font-semibold tracking-[-0.01em]">{k.value}</div>
          <div className={cx("h-[18px] text-[12px]", k.delta ? (k.delta.good ? "text-positive" : "text-negative") : "text-subtle-2")}>
            {k.delta ? k.delta.text : ""}
          </div>
        </div>
      ))}
    </div>
  );
}
