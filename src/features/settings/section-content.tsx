import { AiSettingsPanel } from "@/features/settings/ai/ai-settings-panel";
import { ChatHistoryPanel } from "@/features/settings/chat-history-panel";
import { AppearancePanel } from "@/features/settings/appearance-panel";
import { LocalDataPanel } from "@/features/settings/local-data-panel";
import {
  PlaceholderPanel,
  type PlaceholderRow,
} from "@/features/settings/placeholder-panel";
import type { SettingsSectionId } from "@/types";

const PLACEHOLDER_ROWS: Record<
  Exclude<SettingsSectionId, "appearance" | "local-data" | "providers" | "models" | "chat">,
  readonly PlaceholderRow[]
> = {
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
};

interface SectionContentProps {
  id: SettingsSectionId;
}

export function SectionContent({ id }: SectionContentProps) {
  if (id === "appearance") return <AppearancePanel />;
  if (id === "local-data") return <LocalDataPanel />;
  if (id === "chat") return <ChatHistoryPanel />;
  if (id === "providers" || id === "models") return <AiSettingsPanel section={id} />;
  return <PlaceholderPanel rows={PLACEHOLDER_ROWS[id]} />;
}
