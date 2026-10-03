import { cx } from "./cx";

/** Notion-style property row. Stacks label above value on mobile. */
export function PropertyRow({
  label,
  children,
  labelWidth = 160,
  className,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  labelWidth?: number;
  className?: string;
}) {
  return (
    <div
      className={cx("flex flex-col gap-0.5 border-b border-line py-1.5 md:grid md:items-center md:gap-3", className)}
      style={{ gridTemplateColumns: `${labelWidth}px minmax(0,1fr)` }}
    >
      <div className="pt-1 text-[13px] text-muted md:pt-0 md:text-[14px]">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export const propertyInputClass =
  "w-full rounded bg-transparent px-2 py-1.5 outline-none transition-quiet placeholder:text-faint hover:bg-hover focus:bg-hover -mx-2 md:mx-0";
