"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useHydrated } from "@/hooks/use-hydrated";
import { useUiStore } from "@/store/ui-store";

export function AppearancePanel() {
  const hydrated = useHydrated();
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 p-5">
        <div>
          <p id="dark-mode-label" className="text-sm font-medium">
            Dark mode
          </p>
          <p className="text-sm text-muted-foreground">
            Dark is the default. Turn off to use the light theme.
          </p>
        </div>
        <Switch
          aria-labelledby="dark-mode-label"
          checked={hydrated ? theme === "dark" : true}
          onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
        />
      </CardContent>
    </Card>
  );
}
