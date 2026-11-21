"use client";

import { useEffect } from "react";

import { UI_FONT_PX } from "@/lib/preferences";
import { usePreferences } from "@/store/preferences-store";

/** Applies the saved theme and text size to <html> whenever they change. */
export function useThemeSync(): void {
  const { theme, uiFontSize } = usePreferences();

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.dataset.theme = theme;
    root.dataset.uiFont = uiFontSize;
    root.style.fontSize = `${UI_FONT_PX[uiFontSize]}px`;
  }, [theme, uiFontSize]);
}
