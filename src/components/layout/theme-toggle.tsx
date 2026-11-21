"use client";

import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { setPreferences, usePreferences } from "@/store/preferences-store";

export function ThemeToggle() {
  const { theme } = usePreferences();
  const setTheme = (next: "dark" | "light") => setPreferences({ theme: next });
  const next = theme === "dark" ? "light" : "dark";

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      {theme === "dark" ? <Sun /> : <Moon />}
    </Button>
  );
}
