"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useHydrated } from "@/hooks/use-hydrated";
import { DEFAULT_PREFERENCES, EDITOR_FONT_MAX, EDITOR_FONT_MIN, clampEditorFont, type EditorThemePref, type UiFontSize } from "@/lib/preferences";
import { preferencesStore, setPreferences, usePreferences } from "@/store/preferences-store";

const selectClass = "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm";

function Row({ id, label, hint, children }: { id: string; label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="min-w-0 flex-1">
        <p id={`${id}-label`} className="text-sm font-medium">{label}</p>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
      {children}
    </div>
  );
}

const EDITOR_THEME_LABELS: Record<EditorThemePref, string> = { auto: "Match the app", dark: "Dark", light: "Light", "high-contrast": "High contrast" };
const UI_FONT_LABELS: Record<UiFontSize, string> = { small: "Small", medium: "Medium (default)", large: "Large" };

/** Theme, text size, sidebar and editor look. Every change applies at once and is saved on this computer. */
export function AppearancePanel() {
  const hydrated = useHydrated();
  const prefs = usePreferences();
  const changed = JSON.stringify(prefs) !== JSON.stringify(DEFAULT_PREFERENCES);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-5 p-5">
          <Row id="dark-mode" label="Dark mode" hint="Dark is the default. Turn off to use the light theme.">
            <Switch aria-labelledby="dark-mode-label" checked={hydrated ? prefs.theme === "dark" : true} onCheckedChange={(checked) => setPreferences({ theme: checked ? "dark" : "light" })} />
          </Row>
          <Row id="ui-font" label="Text size" hint="Scales the text of the whole app.">
            <select aria-labelledby="ui-font-label" className={`${selectClass} w-48`} value={prefs.uiFontSize} onChange={(e) => setPreferences({ uiFontSize: e.target.value as UiFontSize })}>
              {(Object.keys(UI_FONT_LABELS) as UiFontSize[]).map((k) => <option key={k} value={k}>{UI_FONT_LABELS[k]}</option>)}
            </select>
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-5 p-5">
          <p className="text-sm font-medium">Sidebar</p>
          <Row id="sidebar-collapsed" label="Collapse the sidebar" hint="Show only icons. The same as the collapse button on the sidebar.">
            <Switch aria-labelledby="sidebar-collapsed-label" checked={prefs.sidebarCollapsed} onCheckedChange={(sidebarCollapsed) => setPreferences({ sidebarCollapsed })} />
          </Row>
          <Row id="sidebar-history" label="Show recent chats" hint="List your chats in the sidebar. Off keeps the sidebar to navigation only.">
            <Switch aria-labelledby="sidebar-history-label" checked={prefs.sidebarHistory} onCheckedChange={(sidebarHistory) => setPreferences({ sidebarHistory })} />
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-5 p-5">
          <p className="text-sm font-medium">Code editor</p>
          <Row id="editor-theme" label="Editor theme" hint="The colours of the Lua editor in the workspace.">
            <select aria-labelledby="editor-theme-label" className={`${selectClass} w-48`} value={prefs.editorTheme} onChange={(e) => setPreferences({ editorTheme: e.target.value as EditorThemePref })}>
              {(Object.keys(EDITOR_THEME_LABELS) as EditorThemePref[]).map((k) => <option key={k} value={k}>{EDITOR_THEME_LABELS[k]}</option>)}
            </select>
          </Row>
          <Row id="editor-font" label="Editor font size" hint={`${EDITOR_FONT_MIN} to ${EDITOR_FONT_MAX} pixels.`}>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" aria-label="Decrease editor font size" disabled={prefs.editorFontSize <= EDITOR_FONT_MIN} onClick={() => setPreferences({ editorFontSize: clampEditorFont(prefs.editorFontSize - 1) })}>−</Button>
              <input
                aria-labelledby="editor-font-label"
                type="number"
                min={EDITOR_FONT_MIN}
                max={EDITOR_FONT_MAX}
                value={prefs.editorFontSize}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && e.target.value !== "") setPreferences({ editorFontSize: clampEditorFont(n) });
                }}
                className="h-9 w-16 rounded-md border border-input bg-transparent px-2 text-center text-sm"
              />
              <Button size="sm" variant="outline" aria-label="Increase editor font size" disabled={prefs.editorFontSize >= EDITOR_FONT_MAX} onClick={() => setPreferences({ editorFontSize: clampEditorFont(prefs.editorFontSize + 1) })}>+</Button>
            </div>
          </Row>
          <pre data-testid="editor-preview" aria-label="Editor preview" data-editor-theme={prefs.editorTheme} style={{ fontSize: `${prefs.editorFontSize}px` }} className="overflow-x-auto rounded-md border border-border bg-secondary/40 p-3 font-mono">{`-- preview\nlocal name = "GTPS"\nprint("Hello, " .. name)`}</pre>
        </CardContent>
      </Card>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={!changed} onClick={() => preferencesStore().reset()}>Reset all preferences to defaults</Button>
      </div>
    </div>
  );
}
