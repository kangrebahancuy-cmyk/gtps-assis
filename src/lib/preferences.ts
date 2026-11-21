/**
 * User preferences that live only in this browser (appearance, editor, sidebar, Markdown rendering).
 * Everything read from storage, an import or a backup goes through `parsePreferences`, which keeps
 * valid values, replaces anything else with the default, and drops unknown fields.
 */

export type ThemeMode = "dark" | "light";
export type UiFontSize = "small" | "medium" | "large";
export type EditorThemePref = "auto" | "dark" | "light" | "high-contrast";
export type EditorTheme = "dark" | "light" | "high-contrast";

export interface Preferences {
  theme: ThemeMode;
  /** Text size of the whole app. */
  uiFontSize: UiFontSize;
  sidebarCollapsed: boolean;
  /** Show the recent chats list in the sidebar. */
  sidebarHistory: boolean;
  /** "auto" follows the app theme. */
  editorTheme: EditorThemePref;
  editorFontSize: number;
  /** Show replies as formatted Markdown (off: show the raw text). */
  renderMarkdown: boolean;
  /** Colour Lua code blocks. */
  highlightCode: boolean;
  /** Wrap long lines in code blocks instead of scrolling sideways. */
  wrapCode: boolean;
}

export const EDITOR_FONT_MIN = 10;
export const EDITOR_FONT_MAX = 24;

export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  theme: "dark",
  uiFontSize: "medium",
  sidebarCollapsed: false,
  sidebarHistory: true,
  editorTheme: "auto",
  editorFontSize: 13,
  renderMarkdown: true,
  highlightCode: true,
  wrapCode: false,
});

export const UI_FONT_SIZES: readonly UiFontSize[] = ["small", "medium", "large"];
export const EDITOR_THEMES: readonly EditorThemePref[] = ["auto", "dark", "light", "high-contrast"];

/** Root font size per setting: Tailwind sizes are rem-based, so this scales the whole interface. */
export const UI_FONT_PX: Record<UiFontSize, number> = { small: 14, medium: 16, large: 18 };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function parsePreferences(raw: unknown): Preferences {
  const d = DEFAULT_PREFERENCES;
  if (!isObject(raw)) return { ...d };
  const bool = (key: keyof Preferences, fallback: boolean): boolean => (typeof raw[key] === "boolean" ? (raw[key] as boolean) : fallback);
  const font = raw.editorFontSize;
  return {
    theme: raw.theme === "light" || raw.theme === "dark" ? raw.theme : d.theme,
    uiFontSize: UI_FONT_SIZES.includes(raw.uiFontSize as UiFontSize) ? (raw.uiFontSize as UiFontSize) : d.uiFontSize,
    sidebarCollapsed: bool("sidebarCollapsed", d.sidebarCollapsed),
    sidebarHistory: bool("sidebarHistory", d.sidebarHistory),
    editorTheme: EDITOR_THEMES.includes(raw.editorTheme as EditorThemePref) ? (raw.editorTheme as EditorThemePref) : d.editorTheme,
    editorFontSize: typeof font === "number" && Number.isInteger(font) && font >= EDITOR_FONT_MIN && font <= EDITOR_FONT_MAX ? font : d.editorFontSize,
    renderMarkdown: bool("renderMarkdown", d.renderMarkdown),
    highlightCode: bool("highlightCode", d.highlightCode),
    wrapCode: bool("wrapCode", d.wrapCode),
  };
}

/** What the editor actually shows: "auto" follows the app theme. */
export const resolveEditorTheme = (editorTheme: EditorThemePref, appTheme: ThemeMode): EditorTheme => (editorTheme === "auto" ? appTheme : editorTheme);

export const clampEditorFont = (value: number): number => Math.min(EDITOR_FONT_MAX, Math.max(EDITOR_FONT_MIN, Math.round(value)));
