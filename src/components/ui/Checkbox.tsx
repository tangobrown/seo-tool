import { cx } from "./cx";

/** 16px visual box. Wrap in a larger hit area where needed. */
export function CheckboxBox({ state }: { state: "on" | "off" | "mixed" }) {
  const on = state !== "off";
  return (
    <span
      aria-hidden
      className={cx(
        "inline-flex size-4 shrink-0 items-center justify-center rounded border-[1.5px] text-[11px] font-bold leading-none text-white",
        on ? "border-ink bg-ink" : "border-faint bg-white",
      )}
    >
      {state === "on" ? "✓" : state === "mixed" ? "–" : ""}
    </span>
  );
}

export function Checkbox({
  state,
  onToggle,
  label,
  className,
}: {
  state: "on" | "off" | "mixed";
  onToggle: () => void;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "mixed" ? "mixed" : state === "on"}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={cx("-m-3.5 inline-flex min-h-11 min-w-11 items-start justify-center p-3.5 md:m-0 md:min-h-0 md:min-w-0 md:p-0", className)}
    >
      <CheckboxBox state={state} />
    </button>
  );
}
