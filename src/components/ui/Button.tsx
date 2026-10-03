import { cx } from "./cx";

type Variant = "primary" | "secondary" | "danger" | "neutral";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-ink text-white hover:bg-ink-hover disabled:bg-disabled border border-transparent",
  secondary: "bg-white border border-control text-ink-3 hover:bg-hover",
  neutral: "bg-white border border-control text-ink hover:bg-hover",
  danger: "bg-white border border-control text-negative hover:bg-tag-red",
};

export function Button({
  variant = "primary",
  className,
  size = "md",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "md" | "lg" }) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex items-center justify-center whitespace-nowrap rounded-md text-[13px] font-medium transition-quiet",
        size === "md" ? "px-3 py-[5px]" : "min-h-11 px-4",
        VARIANTS[variant],
        className,
      )}
    />
  );
}
