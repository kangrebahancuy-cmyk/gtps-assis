import { AiSettingsPanel } from "@/features/settings/ai/ai-settings-panel";
import { AppearancePanel } from "@/features/settings/appearance-panel";
import { BackupPanel } from "@/features/settings/backup-panel";
import { ChatSettingsPanel } from "@/features/settings/chat-settings-panel";
import { DocumentationPanel } from "@/features/settings/documentation-panel";
import { LocalDataPanel } from "@/features/settings/local-data-panel";
import { SynchronizationPanel } from "@/features/settings/synchronization-panel";
import type { SettingsSectionId } from "@/types";

interface SectionContentProps {
  id: SettingsSectionId;
}

export function SectionContent({ id }: SectionContentProps) {
  switch (id) {
    case "providers":
    case "models":
      return <AiSettingsPanel section={id} />;
    case "documentation":
      return <DocumentationPanel />;
    case "synchronization":
      return <SynchronizationPanel />;
    case "chat":
      return <ChatSettingsPanel />;
    case "local-data":
      return <LocalDataPanel />;
    case "backup":
      return <BackupPanel />;
    case "appearance":
      return <AppearancePanel />;
  }
}
