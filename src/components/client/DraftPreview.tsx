"use client";

import { useEffect } from "react";

/** Reading view for a blog draft, styled like the report document (680px). */
export function DraftPreview({ draft, onClose }: { draft: { title: string; body: string }; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const paras = draft.body.split(/\n{2,}/);
  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-white" role="dialog" aria-modal="true" aria-label="Draft preview">
      <div className="mx-auto max-w-[680px] px-4 pb-24 pt-[calc(16px+env(safe-area-inset-top))] md:pt-9">
        <button type="button" onClick={onClose} className="-ml-1.5 mb-4 min-h-11 rounded px-1.5 py-0.5 text-muted transition-quiet hover:bg-hover md:min-h-0">
          ← Back to recommendations
        </button>
        <div className="mb-2 text-[12px] text-subtle-2">Draft preview</div>
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.01em] md:text-[32px]">{draft.title}</h1>
        <div className="mt-5 border-t border-line pt-5 text-[16px] leading-[1.6] md:text-[17px]">
          {paras.map((p, i) => (
            <p key={i} className="mb-4 whitespace-pre-line">
              {p}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
