import { cx } from "./cx";

export type Bar = { label: string; value: number | null; current?: boolean; title?: string };

/** Bars with null value render as grey placeholders (no data yet). */
export function BarChart({ bars, height = 140 }: { bars: Bar[]; height?: number }) {
  const max = Math.max(1, ...bars.map((b) => b.value ?? 0));
  return (
    <div>
      <div className="flex items-end gap-1 border-b border-line md:gap-2" style={{ height }}>
        {bars.map((b, i) =>
          b.value === null ? (
            <div key={i} className="flex-1 rounded-t-[3px] bg-sidebar" style={{ height: "18%" }} title={`${b.label}: no data`} />
          ) : (
            <div
              key={i}
              title={b.title}
              className={cx("flex-1 rounded-t-[3px]", b.current ? "bg-ink" : "bg-toggle-off")}
              style={{ height: `${Math.max(2, (b.value / max) * 100)}%` }}
            />
          ),
        )}
      </div>
      <div className="mt-1.5 flex gap-1 md:gap-2">
        {bars.map((b, i) => (
          <div key={i} className="flex-1 text-center text-[11px] text-subtle-2">
            {b.label}
          </div>
        ))}
      </div>
    </div>
  );
}
