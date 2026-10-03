"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

type ToastInput = { message: string; undo?: () => void | Promise<void>; durationMs?: number };
type ToastState = ToastInput & { id: number };

const ToastContext = createContext<(t: ToastInput) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((t: ToastInput) => {
    if (timer.current) clearTimeout(timer.current);
    const id = Date.now();
    setToast({ ...t, id });
    timer.current = setTimeout(() => setToast((cur) => (cur?.id === id ? null : cur)), t.durationMs ?? (t.undo ? 6000 : 4000));
  }, []);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 z-50 flex justify-center px-4"
          style={{ bottom: "calc(24px + env(safe-area-inset-bottom) + var(--action-bar-h, 0px))" }}
        >
          <div className="pointer-events-auto flex max-w-full items-center gap-3 rounded-lg bg-ink px-3.5 py-[9px] text-[13px] text-white shadow-toast">
            <span>{toast.message}</span>
            {toast.undo && (
              <button
                type="button"
                className="-my-3 py-3 text-faint underline underline-offset-2 hover:text-white"
                onClick={async () => {
                  const undo = toast.undo;
                  setToast(null);
                  await undo?.();
                }}
              >
                Undo
              </button>
            )}
          </div>
        </div>
      )}
    </ToastContext.Provider>
  );
}
