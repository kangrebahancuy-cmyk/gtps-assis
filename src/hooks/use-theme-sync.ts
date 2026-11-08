"use client";

import { useEffect } from "react";

import { useUiStore } from "@/store/ui-store";

/** Applies the persisted theme to <html> whenever it changes. */
export function useThemeSync(): void {
  const theme = useUiStore((state) => state.theme);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);
}
