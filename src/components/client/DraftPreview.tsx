"use client";

import { useEffect } from "react";

/** Reading view for a blog draft, styled like the report document (680px). */
export function DraftPreview({ draft, onClose }: { draft: { title: string; body: string }; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Drafts are Markdown: headings, paragraphs and simple lists. Rendered as text, never as HTML.
  const blocks = draft.body.split(/\n{2,}/).flatMap((b) => {
    const t = b.trim();
    // A heading followed by text in the same block becomes two blocks.
    const m = /^(#{2,3} [^\n]+)\n([\s\S]+)$/.exec(t);
    return m ? [m[1]!, m[2]!.trim()] : t ? [t] : [];
  });
  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-white" role="dialog" aria-modal="true" aria-label="Draft preview">
      <div className="mx-auto max-w-[680px] px-4 pb-24 pt-[calc(16px+env(safe-area-inset-top))] md:pt-9">
        <button type="button" onClick={onClose} className="-ml-1.5 mb-4 min-h-11 rounded px-1.5 py-0.5 text-muted transition-quiet hover:bg-hover md:min-h-0">
          ← Back to recommendations
        </button>
        <div className="mb-2 text-[12px] text-subtle-2">Draft preview</div>
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.01em] md:text-[32px]">{draft.title}</h1>
        <div className="mt-5 border-t border-line pt-5 text-[16px] leading-[1.6] md:text-[17px]">
          {blocks.map((b, i) => {
            const text = (t: string) => t.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\[(.+?)\]\([^)]*\)/g, "$1");
            if (b.startsWith("### ")) return <h3 key={i} className="mb-2 mt-6 text-[17px] font-semibold md:text-[18px]">{text(b.slice(4))}</h3>;
            if (b.startsWith("## ")) return <h2 key={i} className="mb-2 mt-7 text-[19px] font-semibold md:text-[21px]">{text(b.slice(3))}</h2>;
            if (/^[-*] /.test(b))
              return (
                <ul key={i} className="mb-4 list-disc pl-5">
                  {b.split("\n").map((li, j) => <li key={j}>{text(li.replace(/^[-*] /, ""))}</li>)}
                </ul>
              );
            return <p key={i} className="mb-4 whitespace-pre-line">{text(b)}</p>;
          })}
        </div>
      </div>
    </div>
  );
}
