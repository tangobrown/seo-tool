"use client";

import { useState } from "react";
import { cx } from "./cx";

export function ChipInput({
  values,
  onChange,
  placeholder = "Add…",
  starred,
  onToggleStar,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  /** Optional: chips can be starred (e.g. priority services). */
  starred?: string[];
  onToggleStar?: (value: string) => void;
}) {
  const [draft, setDraft] = useState("");

  function add() {
    const v = draft.trim();
    if (!v) return;
    if (!values.some((x) => x.toLowerCase() === v.toLowerCase())) onChange([...values, v]);
    setDraft("");
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 py-1">
      {values.map((v) => {
        const isStar = starred?.includes(v);
        return (
          <span key={v} className="inline-flex items-center gap-1 rounded bg-hover-2 py-0.5 pl-2 pr-1 text-[13px]">
            {onToggleStar && (
              <button
                type="button"
                aria-label={isStar ? `Unmark ${v} as priority` : `Mark ${v} as priority`}
                aria-pressed={isStar}
                onClick={() => onToggleStar(v)}
                className={cx("-my-1 -ml-1 px-1 py-1", isStar ? "text-tag-yellow-fg" : "text-faint hover:text-muted")}
              >
                {isStar ? "★" : "☆"}
              </button>
            )}
            {v}
            <button
              type="button"
              aria-label={`Remove ${v}`}
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="-my-1 px-1.5 py-1 text-subtle-2 hover:text-ink"
            >
              ×
            </button>
          </span>
        );
      })}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && !draft && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={add}
        placeholder={placeholder}
        enterKeyHint="done"
        className="min-w-[120px] flex-1 rounded bg-transparent px-2 py-1 outline-none placeholder:text-faint focus:bg-hover"
      />
    </div>
  );
}
