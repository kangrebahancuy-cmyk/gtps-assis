import type {
  NavItem,
  SettingsSection,
} from "@/types";

export const APP_NAME = "GTPS Assistant";
export const APP_TAGLINE = "Your AI-powered GTPS development companion.";

export const NAV_ITEMS: readonly NavItem[] = [
  { id: "docs", label: "Documentation", href: "/docs", icon: "book" },
  { id: "workspace", label: "Lua Workspace", href: "/workspace", icon: "code" },
  { id: "models", label: "AI Models", href: "/settings/models", icon: "cpu" },
  {
    id: "settings",
    label: "Settings",
    href: "/settings/providers",
    icon: "settings",
    excludePrefixes: ["/settings/models"],
  },
];

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "providers",
    label: "AI Providers",
    description: "Connect the AI providers you want to use.",
  },
  {
    id: "models",
    label: "Models",
    description: "Choose default models for chat and code generation.",
  },
  {
    id: "documentation",
    label: "Documentation",
    description: "Manage documentation sources and indexing.",
  },
  {
    id: "synchronization",
    label: "Synchronization",
    description: "Keep documentation and settings up to date.",
  },
  {
    id: "chat",
    label: "Chat Preferences",
    description: "Tune how conversations behave and look.",
  },
  {
    id: "local-data",
    label: "Local Data",
    description: "Review and clear data stored in this browser.",
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Switch between dark and light mode.",
  },
];

export const EXAMPLE_PROMPTS: readonly string[] = [
  "Create a custom player command.",
  "Explain GTPS Cloud API.",
  "Create a reward system.",
  "Debug my Lua script.",
];


export const PLACEHOLDER_PROVIDERS: readonly string[] = [
  "No provider connected",
];

export const PLACEHOLDER_MODELS: readonly string[] = ["No model available"];

export const INITIAL_LUA_FILES = [
  {
    id: "file_main",
    name: "main.lua",
    content: "-- main.lua\n-- Workspace placeholder. Write your Lua here.\n",
  },
  {
    id: "file_scratch",
    name: "scratch.lua",
    content: "-- scratch.lua\n",
  },
] as const;
