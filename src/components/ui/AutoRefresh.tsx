"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Refreshes server data on an interval while some background work is in progress. */
export function AutoRefresh({ everyMs = 4000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}
