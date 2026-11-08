"use client";

import { useSyncExternalStore } from "react";

const subscribe = (): (() => void) => () => undefined;

/**
 * Returns false during server render and the first hydration pass, then true.
 * Use it to avoid hydration mismatches for state restored from localStorage.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
