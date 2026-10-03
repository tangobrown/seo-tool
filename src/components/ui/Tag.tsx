import { cx } from "./cx";

export type TagColor = "gray" | "green" | "red" | "yellow" | "blue" | "purple" | "orange";

const COLORS: Record<TagColor, string> = {
  gray: "bg-tag-gray text-tag-gray-fg",
  green: "bg-tag-green text-tag-green-fg",
  red: "bg-tag-red text-tag-red-fg",
  yellow: "bg-tag-yellow text-tag-yellow-fg",
  blue: "bg-tag-blue text-tag-blue-fg",
  purple: "bg-tag-purple text-tag-purple-fg",
  orange: "bg-tag-orange text-tag-orange-fg",
};

export function Tag({ color = "gray", children, className }: { color?: TagColor; children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center whitespace-nowrap rounded px-[7px] py-px text-[12px] leading-[18px]",
        COLORS[color],
        className,
      )}
    >
      {children}
    </span>
  );
}
