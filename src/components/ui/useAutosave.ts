"use client";

import { useCallback, useEffect, useRef } from "react";

/** Debounced save (500ms). Flushes on unmount so nothing typed is lost. */
export function useDebouncedSave<T>(save: (value: T) => Promise<unknown>, delay = 500) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ value: T } | null>(null);
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pending.current) {
      const { value } = pending.current;
      pending.current = null;
      void saveRef.current(value);
    }
  }, []);

  useEffect(() => flush, [flush]);

  return useCallback(
    (value: T) => {
      pending.current = { value };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, delay);
    },
    [delay, flush],
  );
}
