export type ThemeMode = "dark" | "light";

export type MessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: number;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: NavIconName;
  /** Pathname prefixes that should NOT mark this item active. */
  excludePrefixes?: readonly string[];
}

export type NavIconName = "book" | "code" | "cpu" | "settings";

export interface LuaFile {
  id: string;
  name: string;
  content: string;
}

export type SettingsSectionId =
  | "providers"
  | "models"
  | "documentation"
  | "synchronization"
  | "chat"
  | "local-data"
  | "appearance";

export interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  description: string;
}

export interface MarkdownListItem {
  text: string;
  /** Nested list under this item, if any. */
  children: { ordered: boolean; items: MarkdownListItem[] } | null;
}

export type TableAlign = "left" | "center" | "right" | null;

export type MarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string; id: string }
  | { type: "list"; ordered: boolean; items: MarkdownListItem[] }
  | { type: "code"; language: string; code: string }
  | { type: "table"; header: string[]; align: TableAlign[]; rows: string[][] };

export type InlineNode =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: InlineNode[] }
  | { type: "em"; children: InlineNode[] }
  | { type: "link"; href: string; children: InlineNode[] };
