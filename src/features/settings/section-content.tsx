import { AppearancePanel } from "@/features/settings/appearance-panel";
import { LocalDataPanel } from "@/features/settings/local-data-panel";
import {
  PlaceholderPanel,
  type PlaceholderRow,
} from "@/features/settings/placeholder-panel";
import type { SettingsSectionId } from "@/types";

const PLACEHOLDER_ROWS: Record<
  Exclude<SettingsSectionId, "appearance" | "local-data">,
  readonly PlaceholderRow[]
> = {
  providers: [
    {
      label: "Provider connections",
      description: "API keys and endpoints for AI providers.",
      status: "No provider connected",
    },
  ],
  models: [
    {
      label: "Default chat model",
      description: "Model used for new conversations.",
      status: "No model available",
    },
    {
      label: "Default code model",
      description: "Model used for Lua generation.",
      status: "No model available",
    },
  ],
  documentation: [
    {
      label: "Documentation sources",
      description: "Where GTPS Cloud documentation is read from.",
      status: "No source configured",
    },
  ],
  synchronization: [
    {
      label: "Automatic sync",
      description: "Refresh documentation in the background.",
      toggle: true,
    },
    {
      label: "Last sync",
      description: "When documentation was last updated.",
      status: "Never",
    },
  ],
  chat: [
    {
      label: "Stream responses",
      description: "Show replies as they are generated.",
      toggle: true,
    },
    {
      label: "Send on Enter",
      description: "Press Enter to send, Shift+Enter for a new line.",
      toggle: true,
    },
  ],
};

interface SectionContentProps {
  id: SettingsSectionId;
}

export function SectionContent({ id }: SectionContentProps) {
  if (id === "appearance") return <AppearancePanel />;
  if (id === "local-data") return <LocalDataPanel />;
  return <PlaceholderPanel rows={PLACEHOLDER_ROWS[id]} />;
}
