import { cx } from "./cx";

export function ToggleSwitch({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cx("relative inline-block h-[18px] w-[30px] shrink-0 rounded-[9px] transition-quiet", on ? "bg-ink" : "bg-toggle-off")}
    >
      <span
        className={cx("absolute top-0.5 size-3.5 rounded-full bg-white shadow-knob", on ? "left-[14px]" : "left-0.5")}
      />
    </span>
  );
}

/** A whole-row toggle: label + description, click anywhere. */
export function ToggleRow({
  label,
  description,
  on,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="flex min-h-11 w-full items-center justify-between gap-4 border-b border-line py-3 text-left disabled:opacity-50"
    >
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        {description && <span className="block text-[13px] text-muted">{description}</span>}
      </span>
      <ToggleSwitch on={on} />
    </button>
  );
}
