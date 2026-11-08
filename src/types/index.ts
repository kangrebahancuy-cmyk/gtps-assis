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

export interface DocCategory {
  id: string;
  label: string;
}

export interface DocPage {
  id: string;
  categoryId: string;
  title: string;
  summary: string;
  body: string;
}

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

export type MarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; language: string; code: string };
