import Link from "next/link";
import { cx } from "./cx";

export type TabItem = { key: string; label: string; href?: string; count?: number; pill?: boolean };

export function Tabs({
  items,
  active,
  onSelect,
  className,
}: {
  items: TabItem[];
  active: string;
  onSelect?: (key: string) => void;
  className?: string;
}) {
  return (
    <div className={cx("no-scrollbar -mx-4 flex gap-5 overflow-x-auto border-b border-line px-4 md:mx-0 md:px-0", className)} role="tablist">
      {items.map((t) => {
        const isActive = t.key === active;
        const cls = cx(
          "-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 py-2 font-medium transition-quiet",
          isActive ? "border-ink text-ink" : "border-transparent text-subtle hover:text-ink-3",
        );
        const content = (
          <>
            {t.label}
            {t.pill && t.count ? (
              <span className="rounded-[9px] bg-tag-red px-1.5 text-[11px] font-semibold leading-[17px] text-tag-red-fg">{t.count}</span>
            ) : null}
          </>
        );
        return t.href ? (
          <Link key={t.key} href={t.href} role="tab" aria-selected={isActive} className={cls} scroll={false}>
            {content}
          </Link>
        ) : (
          <button key={t.key} type="button" role="tab" aria-selected={isActive} className={cls} onClick={() => onSelect?.(t.key)}>
            {content}
          </button>
        );
      })}
    </div>
  );
}
