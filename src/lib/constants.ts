import type {
  NavItem,
  SettingsSection,
} from "@/types";

export const APP_NAME = "GTPS Assistant";
export const APP_TAGLINE = "Your AI-powered GTPS development companion.";

export const NAV_ITEMS: readonly NavItem[] = [
  { id: "generator", label: "Script Generator", href: "/generator", icon: "wand" },
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
    description: "Choose where the documentation is read from and which sites are allowed.",
  },
  {
    id: "synchronization",
    label: "Synchronization",
    description: "Run, schedule and review documentation synchronization.",
  },
  {
    id: "chat",
    label: "Chat Preferences",
    description: "Default model, reply display and chat history.",
  },
  {
    id: "local-data",
    label: "Local Data",
    description: "Review and clear data stored in this browser.",
  },
  {
    id: "backup",
    label: "Backup & Restore",
    description: "Export everything you created here, or restore it from a backup file.",
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Theme, text size, sidebar and code editor.",
  },
];

export const EXAMPLE_PROMPTS: readonly string[] = [
  "Create a custom player command.",
  "Explain GTPS Cloud API.",
  "Create a reward system.",
  "Debug my Lua script.",
];

/** Starting points for the Script Generator: the kinds of scripts it is built for. */
export const GENERATOR_PROMPTS: readonly { label: string; prompt: string }[] = [
  { label: "Custom player command", prompt: "Create a custom player command /hello that greets the player by name." },
  { label: "Daily reward system", prompt: "Create a daily reward system: each player can claim a reward once every 24 hours and is told when they can claim again." },
  { label: "NPC shop", prompt: "Create an NPC shop where players can buy items for gems." },
  { label: "Automatic event", prompt: "Create an automatic event that announces itself to all players every 30 minutes." },
  { label: "Player moderation system", prompt: "Create a player moderation system with kick and mute commands that only admins can use." },
  { label: "Mailbox reward system", prompt: "Create a mailbox reward system that sends a mail with an item reward to a player." },
  { label: "Custom item interaction", prompt: "Create a custom item interaction: when a player activates a special item on a tile, something happens in the world." },
];

export const PLACEHOLDER_PROVIDERS: readonly string[] = [
  "No provider connected",
];

export const PLACEHOLDER_MODELS: readonly string[] = ["No model available"];

