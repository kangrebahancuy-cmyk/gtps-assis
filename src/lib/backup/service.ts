/**
 * Backup and restore on top of the controllers (chat, workspace) and the preferences store.
 * Framework-free: the settings page and the tests use the same functions.
 */
import type { ChatController } from "@/lib/chat/controller";
import type { Preferences } from "@/lib/preferences";
import type { PreferencesStore } from "@/lib/preferences-store";
import type { WorkspaceController } from "@/lib/workspace/controller";
import { buildBackup, type BackupData, type BackupFile, type ParsedBackup } from "@/lib/backup/format";
import { planRestore, type CurrentData, type RestoreOptions, type RestorePlan } from "@/lib/backup/plan";

export interface BackupPorts {
  chat: Pick<ChatController, "backupData" | "restoreData">;
  workspace: Pick<WorkspaceController, "backupData" | "restoreData">;
  preferences: Pick<PreferencesStore, "get" | "replace">;
}

/** Reads all current data (also flushes unsaved workspace drafts to storage first). */
export async function collectData(ports: BackupPorts): Promise<BackupData> {
  const [chats, workspace] = await Promise.all([ports.chat.backupData(), ports.workspace.backupData()]);
  return { chats, workspace, preferences: { ...ports.preferences.get() } };
}

export async function createBackup(ports: BackupPorts, now = new Date()): Promise<BackupFile> {
  return buildBackup(await collectData(ports), now);
}

const currentOf = (data: BackupData): CurrentData => ({ conversations: data.chats.conversations, files: data.workspace.files, preferences: data.preferences });

/** Plan only: nothing is changed. */
export async function previewRestore(ports: BackupPorts, backup: ParsedBackup, options: RestoreOptions): Promise<RestorePlan> {
  return planRestore(backup.data, currentOf(await collectData(ports)), options);
}

export interface RestoreReport {
  chatsAdded: number;
  chatsReplaced: number;
  chatsRemoved: number;
  filesAdded: number;
  filesReplaced: number;
  filesRemoved: number;
  skipped: number;
  preferencesRestored: boolean;
}

/**
 * Applies a restore. The plan is recomputed from the CURRENT data right before writing (it may have changed since the
 * preview). If any step fails, everything already written is put back and the error is thrown.
 */
export async function applyRestore(ports: BackupPorts, backup: ParsedBackup, options: RestoreOptions): Promise<{ report: RestoreReport; plan: RestorePlan }> {
  const before = await collectData(ports);
  const plan = planRestore(backup.data, currentOf(before), options);
  const replaceAll = options.mode === "replace-all";
  let chatsDone = false;
  let filesDone = false;
  try {
    const chatResult = await ports.chat.restoreData({
      conversations: plan.apply.chats.conversations,
      replaceAll,
      replaceIds: plan.apply.chats.replaceIds,
      ...(options.preferences ? { docsSearch: backup.data.chats.docsSearch } : {}),
    });
    chatsDone = true;
    await ports.workspace.restoreData({
      files: plan.apply.files.files,
      replaceAll,
      removeIds: plan.apply.files.removeIds,
      ...(replaceAll ? { tabs: backup.data.workspace.tabs, activeId: backup.data.workspace.activeId } : {}),
      ...(replaceAll || options.preferences ? { ai: backup.data.workspace.ai } : {}),
    });
    filesDone = true;
    if (options.preferences) ports.preferences.replace({ ...backup.data.preferences } as Preferences);
    return {
      plan,
      report: {
        chatsAdded: chatResult.conversations,
        chatsReplaced: plan.apply.chats.replaceIds.length,
        chatsRemoved: plan.chats.removed.length - plan.apply.chats.replaceIds.length,
        filesAdded: plan.apply.files.files.length,
        filesReplaced: plan.apply.files.removeIds.length,
        filesRemoved: replaceAll ? plan.files.removed.length : 0,
        skipped: plan.chats.identical.length + plan.files.identical.length + (options.onConflict === "skip" && !replaceAll ? plan.chats.conflicts.length + plan.files.conflicts.length : 0),
        preferencesRestored: options.preferences,
      },
    };
  } catch (error) {
    // Put back what was written before the failure (each controller already rolls back its own half-done write).
    if (chatsDone) await ports.chat.restoreData({ conversations: before.chats.conversations, replaceAll: true, docsSearch: before.chats.docsSearch }).catch(() => {});
    if (filesDone) await ports.workspace.restoreData({ files: before.workspace.files, replaceAll: true, tabs: before.workspace.tabs, activeId: before.workspace.activeId, ai: before.workspace.ai }).catch(() => {});
    ports.preferences.replace({ ...before.preferences });
    throw error;
  }
}
