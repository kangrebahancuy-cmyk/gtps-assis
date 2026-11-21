/**
 * Works out, WITHOUT changing anything, what restoring a backup would do to the data that exists now.
 * The settings page shows this plan and only applies it after the user confirms.
 */
import { newId } from "@/lib/chat/ids";
import type { ExportedConversation } from "@/lib/chat/types";
import { DEFAULT_PREFERENCES, type Preferences } from "@/lib/preferences";
import { uniqueFileName } from "@/lib/workspace-files";
import { textOf, type WorkspaceFile } from "@/lib/workspace/types";
import type { BackupData, BackupSummary } from "@/lib/backup/format";

/**
 * What to do with an item that exists in both places but is not identical:
 *   keep-both  keep yours and add the backup's version next to it (renamed)
 *   skip       keep yours, ignore the backup's version
 *   replace    overwrite yours with the backup's version
 */
export type ConflictPolicy = "keep-both" | "skip" | "replace";

export interface RestoreOptions {
  /** merge: add to what exists. replace-all: make this browser look exactly like the backup. */
  mode: "merge" | "replace-all";
  onConflict: ConflictPolicy;
  /** Also restore appearance, editor, sidebar and Markdown preferences. */
  preferences: boolean;
}

export const DEFAULT_RESTORE_OPTIONS: RestoreOptions = { mode: "merge", onConflict: "keep-both", preferences: false };

export interface PlanItem {
  id: string;
  label: string;
}

export interface CategoryPlan {
  /** Only in the backup: will be added. */
  added: PlanItem[];
  /** Same in both: nothing to do. */
  identical: PlanItem[];
  /** In both, but different: handled by the conflict policy. */
  conflicts: PlanItem[];
  /** Existing items that this restore deletes (replace-all, or "replace" conflicts). */
  removed: PlanItem[];
}

export interface RestorePlan {
  options: RestoreOptions;
  chats: CategoryPlan;
  files: CategoryPlan;
  preferences: { restore: boolean; changed: Array<keyof Preferences> };
  now: BackupSummary;
  backup: BackupSummary;
  /** What the exact calls to the controllers will be. */
  apply: {
    chats: { conversations: ExportedConversation[]; replaceAll: boolean; replaceIds: string[] };
    files: { files: WorkspaceFile[]; replaceAll: boolean; removeIds: string[] };
  };
}

const emptyCategory = (): CategoryPlan => ({ added: [], identical: [], conflicts: [], removed: [] });

export function sameChat(a: ExportedConversation, b: ExportedConversation): boolean {
  return (
    a.title === b.title &&
    a.messages.length === b.messages.length &&
    a.messages.every((m, i) => {
      const o = b.messages[i]!;
      return m.id === o.id && m.role === o.role && m.content === o.content;
    })
  );
}

/** Same title and the same messages in the same order, ignoring ids (a restored copy gets new ids). */
export const sameChatContent = (a: ExportedConversation, b: ExportedConversation): boolean =>
  a.title === b.title && a.messages.length === b.messages.length && a.messages.every((m, i) => m.role === b.messages[i]!.role && m.content === b.messages[i]!.content);

export const sameFile = (a: WorkspaceFile, b: WorkspaceFile): boolean => a.name === b.name && a.content === b.content && textOf(a) === textOf(b);

const summaryOf = (chats: ExportedConversation[], files: WorkspaceFile[]): BackupSummary => ({
  conversations: chats.length,
  messages: chats.reduce((n, c) => n + c.messages.length, 0),
  files: files.length,
});

export interface CurrentData {
  conversations: ExportedConversation[];
  files: WorkspaceFile[];
  preferences: Preferences;
}

export function planRestore(backup: BackupData, current: CurrentData, options: RestoreOptions): RestorePlan {
  const chats = emptyCategory();
  const files = emptyCategory();
  const chatLabel = (c: ExportedConversation): PlanItem => ({ id: c.id, label: c.title });
  const fileLabel = (f: WorkspaceFile): PlanItem => ({ id: f.id, label: f.name });
  const apply: RestorePlan["apply"] = {
    chats: { conversations: [], replaceAll: options.mode === "replace-all", replaceIds: [] },
    files: { files: [], replaceAll: options.mode === "replace-all", removeIds: [] },
  };

  if (options.mode === "replace-all") {
    const byId = new Map(current.conversations.map((c) => [c.id, c]));
    for (const c of backup.chats.conversations) {
      const have = byId.get(c.id);
      if (!have) chats.added.push(chatLabel(c));
      else if (sameChat(have, c)) chats.identical.push(chatLabel(c));
      else chats.conflicts.push(chatLabel(c));
    }
    const keep = new Set(backup.chats.conversations.map((c) => c.id));
    chats.removed = current.conversations.filter((c) => !keep.has(c.id)).map(chatLabel);
    apply.chats.conversations = backup.chats.conversations;

    const filesById = new Map(current.files.map((f) => [f.id, f]));
    for (const f of backup.workspace.files) {
      const have = filesById.get(f.id);
      if (!have) files.added.push(fileLabel(f));
      else if (sameFile(have, f)) files.identical.push(fileLabel(f));
      else files.conflicts.push(fileLabel(f));
    }
    const keepFiles = new Set(backup.workspace.files.map((f) => f.id));
    files.removed = current.files.filter((f) => !keepFiles.has(f.id)).map(fileLabel);
    apply.files.files = backup.workspace.files;
  } else {
    const byId = new Map(current.conversations.map((c) => [c.id, c]));
    for (const c of backup.chats.conversations) {
      const have = byId.get(c.id);
      if (!have) {
        chats.added.push(chatLabel(c));
        apply.chats.conversations.push(c);
      } else if (sameChat(have, c)) {
        chats.identical.push(chatLabel(c));
      } else {
        const copy: ExportedConversation = { ...c, id: newId("chat"), title: `${c.title} (restored)`, titleSource: "manual" };
        if (options.onConflict === "keep-both" && current.conversations.some((x) => sameChatContent(x, copy))) {
          // Restoring the same backup twice must not pile up copies: this one was already restored.
          chats.identical.push(chatLabel(c));
          continue;
        }
        chats.conflicts.push(chatLabel(c));
        if (options.onConflict === "keep-both") {
          // A copy with its own id; the importer gives the copied messages fresh ids where they would collide.
          apply.chats.conversations.push(copy);
        } else if (options.onConflict === "replace") {
          apply.chats.replaceIds.push(c.id);
          apply.chats.conversations.push(c);
          chats.removed.push(chatLabel(have));
        }
      }
    }

    const names = new Set(current.files.map((f) => f.name.toLowerCase()));
    const live = new Map(current.files.map((f) => [f.id, f]));
    for (const f of backup.workspace.files) {
      const byId = live.get(f.id);
      const byName = current.files.find((x) => x.name.toLowerCase() === f.name.toLowerCase());
      const match = byId ?? byName;
      if (!match) {
        files.added.push(fileLabel(f));
        apply.files.files.push(f);
        names.add(f.name.toLowerCase());
      } else if (sameFile(match, f)) {
        files.identical.push(fileLabel(f));
      } else {
        if (options.onConflict === "keep-both" && current.files.some((x) => x.content === f.content && textOf(x) === textOf(f))) {
          files.identical.push(fileLabel(f)); // the backup's text already exists in another file: no second copy
          continue;
        }
        files.conflicts.push(fileLabel(f));
        if (options.onConflict === "keep-both") {
          const name = uniqueFileName([...names], f.name);
          names.add(name);
          apply.files.files.push({ ...f, id: newId("file"), name });
        } else if (options.onConflict === "replace") {
          for (const gone of new Set([byId, byName].filter((x): x is WorkspaceFile => x !== undefined))) {
            if (!apply.files.removeIds.includes(gone.id)) {
              apply.files.removeIds.push(gone.id);
              files.removed.push(fileLabel(gone));
              names.delete(gone.name.toLowerCase());
            }
          }
          apply.files.files.push(f);
          names.add(f.name.toLowerCase());
        }
      }
    }
  }

  const changed = (Object.keys(DEFAULT_PREFERENCES) as Array<keyof Preferences>).filter((k) => backup.preferences[k] !== current.preferences[k]);
  return {
    options,
    chats,
    files,
    preferences: { restore: options.preferences, changed },
    now: summaryOf(current.conversations, current.files),
    backup: summaryOf(backup.chats.conversations, backup.workspace.files),
    apply,
  };
}

/** True when applying the plan would delete or overwrite something that exists now. */
export const isDestructive = (plan: RestorePlan): boolean =>
  plan.options.mode === "replace-all"
    ? plan.now.conversations > 0 || plan.now.files > 0
    : plan.chats.removed.length > 0 || plan.files.removed.length > 0 || (plan.preferences.restore && plan.preferences.changed.length > 0);
