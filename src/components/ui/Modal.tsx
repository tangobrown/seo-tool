"use client";

import { useEffect } from "react";

/** Centred dialog on desktop; full-width bottom sheet below md. */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  width = 440,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-[rgba(15,15,15,0.35)] md:items-start md:pt-[12vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[92dvh] w-full overflow-y-auto rounded-t-[10px] bg-white p-[22px] pb-[calc(22px+env(safe-area-inset-bottom))] shadow-modal md:w-[var(--modal-w)] md:max-w-[calc(100%-32px)] md:rounded-[10px] md:pb-[22px]"
        style={{ "--modal-w": `${width}px` } as React.CSSProperties}
      >
        <div>
          <h2 className="text-[18px] font-semibold">{title}</h2>
          {subtitle && <p className="mt-1 text-muted">{subtitle}</p>}
          <div className="mt-4">{children}</div>
        </div>
      </div>
    </div>
  );
}

export const fieldLabelClass = "mb-1 block text-[13px] text-muted";
export const fieldInputClass =
  "w-full rounded-md border border-control bg-white px-2.5 py-[7px] outline-none transition-quiet focus:border-subtle-2 min-h-11 md:min-h-0";
