"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useChat } from "@/features/chat/chat-provider";
import { useWorkspace } from "@/features/workspace/workspace-provider";
import { BackupError, MAX_BACKUP_BYTES, backupFileName, parseBackup, type ParsedBackup } from "@/lib/backup/format";
import { DEFAULT_RESTORE_OPTIONS, isDestructive, type CategoryPlan, type ConflictPolicy, type RestoreOptions, type RestorePlan } from "@/lib/backup/plan";
import { applyRestore, createBackup, previewRestore, type BackupPorts, type RestoreReport } from "@/lib/backup/service";
import { downloadText } from "@/lib/download";
import { preferencesStore } from "@/store/preferences-store";

const selectClass = "h-9 rounded-md border border-input bg-transparent px-3 text-sm";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function CategoryLine({ label, plan, policy }: { label: string; plan: CategoryPlan; policy: ConflictPolicy | "replace-all" }) {
  const conflict =
    plan.conflicts.length === 0
      ? null
      : policy === "replace-all"
        ? `${plan.conflicts.length} differ and will be overwritten by the backup's version`
        : policy === "keep-both"
          ? `${plan.conflicts.length} differ: the backup's version is added next to yours`
          : policy === "skip"
            ? `${plan.conflicts.length} differ: yours are kept, the backup's are ignored`
            : `${plan.conflicts.length} differ: yours are overwritten by the backup's version`;
  return (
    <li data-testid={`plan-${label.toLowerCase()}`}>
      <span className="font-medium">{label}:</span> {plan.added.length} to add, {plan.identical.length} already identical (skipped)
      {conflict ? `, ${conflict}` : ""}
      {plan.removed.length > 0 ? <span className="text-destructive">, {plan.removed.length} of yours will be deleted</span> : null}
    </li>
  );
}

/** Export of everything created in this browser, and a guarded restore. Nothing changes until the user confirms. */
export function BackupPanel() {
  const { chat } = useChat();
  const { workspace } = useWorkspace();
  const ports: BackupPorts | null = useMemo(() => (chat && workspace ? { chat, workspace, preferences: preferencesStore() } : null), [chat, workspace]);

  const [exportNotice, setExportNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [loaded, setLoaded] = useState<{ name: string; parsed: ParsedBackup } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [options, setOptions] = useState<RestoreOptions>(DEFAULT_RESTORE_OPTIONS);
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [stage, setStage] = useState<"idle" | "confirm" | "working">("idle");
  const [understood, setUnderstood] = useState(false);
  const [safety, setSafety] = useState(true);
  const [result, setResult] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Keep the preview in step with the chosen options (and with the data as it is now).
  useEffect(() => {
    if (!ports || !loaded) {
      setPlan(null);
      return;
    }
    let live = true;
    previewRestore(ports, loaded.parsed, options).then(
      (next) => live && setPlan(next),
      (error: unknown) => live && setLoadError(error instanceof Error ? error.message : "Could not compare the backup with your data."),
    );
    return () => {
      live = false;
    };
  }, [ports, loaded, options]);

  const reset = useCallback(() => {
    setLoaded(null);
    setPlan(null);
    setStage("idle");
    setUnderstood(false);
    setOptions(DEFAULT_RESTORE_OPTIONS);
    if (fileInput.current) fileInput.current.value = "";
  }, []);

  async function exportAll() {
    if (!ports) return;
    setExportNotice(null);
    try {
      const file = await createBackup(ports);
      downloadText(backupFileName(), JSON.stringify(file, null, 2));
      const s = file.summary;
      setExportNotice({ tone: "ok", text: `Backup downloaded: ${plural(s.conversations, "chat")} (${plural(s.messages, "message")}), ${plural(s.files, "Lua file")} and your preferences.` });
    } catch (error) {
      setExportNotice({ tone: "error", text: `Could not create the backup: ${error instanceof Error ? error.message : "unknown error"}` });
    }
  }

  async function pick(file: File | undefined) {
    setResult(null);
    setLoadError(null);
    setLoaded(null);
    setStage("idle");
    setUnderstood(false);
    if (!file) return;
    if (file.size > MAX_BACKUP_BYTES) {
      setLoadError("The file is too large to be a backup.");
      return;
    }
    try {
      const parsed = await parseBackup(await file.text());
      setLoaded({ name: file.name, parsed });
    } catch (error) {
      // Nothing was changed. A rejected file is never partly imported.
      setLoadError(error instanceof BackupError ? error.message : "The file could not be read.");
    }
  }

  async function restore() {
    if (!ports || !loaded) return;
    setStage("working");
    setResult(null);
    try {
      if (safety && plan && isDestructive(plan)) {
        downloadText(`gtps-assistant-before-restore-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await createBackup(ports), null, 2));
      }
      const { report } = await applyRestore(ports, loaded.parsed, options);
      setResult({ tone: "ok", text: describeReport(report) });
      reset();
    } catch (error) {
      setStage("idle");
      setResult({ tone: "error", text: `The restore failed and your data was put back as it was: ${error instanceof Error ? error.message : "unknown error"}` });
    }
  }

  const destructive = plan ? isDestructive(plan) : false;
  const replaceAll = options.mode === "replace-all";
  const policy: ConflictPolicy | "replace-all" = replaceAll ? "replace-all" : options.onConflict;
  const nothingToDo = plan !== null && !destructive && plan.apply.chats.conversations.length === 0 && plan.apply.files.files.length === 0 && !(options.preferences && plan.preferences.changed.length > 0);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-5">
          <div>
            <p className="text-sm font-medium">Export all local data</p>
            <p className="text-sm text-muted-foreground">
              One JSON file with your chats, Lua workspace files (including unsaved edits), open tabs and preferences. API keys, the documentation index and the documentation source settings are never included.
            </p>
          </div>
          <Button size="sm" onClick={() => void exportAll()} disabled={!ports}>Download backup</Button>
          {!ports ? <p className="text-xs text-muted-foreground">Waiting for local storage to be ready…</p> : null}
          {exportNotice ? <p role={exportNotice.tone === "error" ? "alert" : "status"} className={exportNotice.tone === "error" ? "text-sm text-destructive" : "text-sm text-emerald-600 dark:text-emerald-400"}>{exportNotice.text}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 p-5">
          <div>
            <p className="text-sm font-medium">Restore from a backup</p>
            <p className="text-sm text-muted-foreground">
              Choose a backup file. It is checked first; nothing is changed until you review what would happen and confirm.
            </p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="backup-file" className="text-sm font-medium">Backup file</label>
            <input id="backup-file" ref={fileInput} type="file" accept="application/json,.json" disabled={!ports || stage === "working"} onChange={(e) => void pick(e.target.files?.[0])} className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-transparent file:px-3 file:py-1.5 file:text-sm" />
          </div>
          {loadError ? <p role="alert" data-testid="backup-error" className="text-sm text-destructive">{loadError} Nothing was imported.</p> : null}

          {loaded ? (
            <div className="space-y-4">
              <div className="rounded-md border border-border p-3 text-sm" data-testid="backup-valid">
                <p className="font-medium text-emerald-600 dark:text-emerald-400">Valid backup: {loaded.name}</p>
                <p className="text-muted-foreground">
                  Created {loaded.parsed.createdAt ? new Date(loaded.parsed.createdAt).toLocaleString() : "at an unknown time"}: {plural(loaded.parsed.summary.conversations, "chat")} ({plural(loaded.parsed.summary.messages, "message")}), {plural(loaded.parsed.summary.files, "Lua file")}.
                </p>
                {loaded.parsed.warnings.length > 0 ? (
                  <ul className="mt-1 list-disc pl-5 text-xs text-amber-600 dark:text-amber-400" data-testid="backup-warnings">
                    {loaded.parsed.warnings.map((w) => <li key={w}>{w}</li>)}
                  </ul>
                ) : null}
              </div>

              <fieldset className="space-y-2" disabled={stage !== "idle"}>
                <legend className="text-sm font-medium">How should it be restored?</legend>
                <label className="flex items-start gap-2 text-sm">
                  <input type="radio" name="restore-mode" checked={options.mode === "merge"} onChange={() => setOptions({ ...options, mode: "merge", preferences: false })} />
                  <span><span className="font-medium">Add to what I have</span> <span className="text-muted-foreground">(recommended). Nothing of yours is deleted unless you choose “replace” below.</span></span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input type="radio" name="restore-mode" checked={options.mode === "replace-all"} onChange={() => setOptions({ ...options, mode: "replace-all", preferences: true })} />
                  <span><span className="font-medium">Replace everything with the backup</span> <span className="text-muted-foreground">Chats and files not in the backup are deleted.</span></span>
                </label>
                {options.mode === "merge" ? (
                  <div className="flex flex-wrap items-center gap-2 pl-6 text-sm">
                    <label htmlFor="restore-conflict">If an item exists in both but differs:</label>
                    <select id="restore-conflict" className={selectClass} value={options.onConflict} onChange={(e) => setOptions({ ...options, onConflict: e.target.value as ConflictPolicy })}>
                      <option value="keep-both">Keep both (add the backup&apos;s copy)</option>
                      <option value="skip">Keep mine, ignore the backup&apos;s</option>
                      <option value="replace">Replace mine with the backup&apos;s</option>
                    </select>
                  </div>
                ) : null}
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={options.preferences} onChange={(e) => setOptions({ ...options, preferences: e.target.checked })} />
                  Also restore my preferences (theme, editor, sidebar, Markdown)
                </label>
              </fieldset>

              {plan ? (
                <div className="space-y-2 rounded-md border border-border p-3 text-sm" data-testid="restore-plan">
                  <p className="font-medium">What would happen</p>
                  <ul className="space-y-1">
                    <CategoryLine label="Chats" plan={plan.chats} policy={policy} />
                    <CategoryLine label="Files" plan={plan.files} policy={policy} />
                    <li data-testid="plan-preferences"><span className="font-medium">Preferences:</span> {options.preferences ? (plan.preferences.changed.length === 0 ? "already the same" : `${plan.preferences.changed.length} setting(s) would change (${plan.preferences.changed.join(", ")})`) : "not restored"}</li>
                  </ul>
                  <p className="text-xs text-muted-foreground">Now: {plural(plan.now.conversations, "chat")}, {plural(plan.now.files, "file")}. In the backup: {plural(plan.backup.conversations, "chat")}, {plural(plan.backup.files, "file")}.</p>
                </div>
              ) : <p className="text-sm text-muted-foreground">Comparing with your data…</p>}

              {stage === "idle" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" disabled={!plan || nothingToDo} onClick={() => { setUnderstood(false); setStage("confirm"); }}>{destructive ? "Restore…" : "Import…"}</Button>
                  <Button size="sm" variant="ghost" onClick={reset}>Discard this file</Button>
                  {nothingToDo ? <span className="text-sm text-muted-foreground" data-testid="nothing-to-do">Everything in this backup is already here, so there is nothing to import.</span> : null}
                </div>
              ) : null}

              {stage !== "idle" && plan ? (
                <div role="alertdialog" aria-label={destructive ? "Confirm restore" : "Confirm import"} data-testid="restore-confirm" className={`space-y-3 rounded-md border p-3 text-sm ${destructive ? "border-destructive/60" : "border-amber-500/50"}`}>
                  {destructive ? (
                    <>
                      <p className="font-medium text-destructive">This will delete or overwrite data in this browser.</p>
                      <p>
                        {replaceAll
                          ? `Your ${plural(plan.now.conversations, "chat")} and ${plural(plan.now.files, "file")} will be replaced by the backup's ${plural(plan.backup.conversations, "chat")} and ${plural(plan.backup.files, "file")}.`
                          : plan.chats.removed.length + plan.files.removed.length > 0
                            ? `${plural(plan.chats.removed.length, "chat")} and ${plural(plan.files.removed.length, "file")} of yours will be overwritten by the backup's version.`
                            : ""}
                        {options.preferences && plan.preferences.changed.length > 0 ? (replaceAll || plan.chats.removed.length + plan.files.removed.length > 0 ? " Your preferences will be replaced too." : "Your current preferences will be replaced by the backup's.") : ""} This cannot be undone from the app.
                      </p>
                      <label className="flex items-center gap-2"><input type="checkbox" checked={safety} onChange={(e) => setSafety(e.target.checked)} /> Download a backup of my current data first</label>
                      <label className="flex items-center gap-2"><input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /> I understand my current data will be replaced</label>
                    </>
                  ) : (
                    <p>
                      Import {plural(plan.apply.chats.conversations.length, "chat")} and {plural(plan.apply.files.files.length, "Lua file")} from this backup? Nothing you have now will be deleted or changed.
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button size="sm" disabled={stage === "working" || (destructive && !understood)} onClick={() => void restore()}>{stage === "working" ? "Working…" : destructive ? "Restore now" : "Import now"}</Button>
                    <Button size="sm" variant="ghost" disabled={stage === "working"} onClick={() => setStage("idle")}>Cancel</Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {result ? <p role={result.tone === "error" ? "alert" : "status"} data-testid="restore-result" className={result.tone === "error" ? "text-sm text-destructive" : "text-sm text-emerald-600 dark:text-emerald-400"}>{result.text}</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}

function describeReport(r: RestoreReport): string {
  const parts = [
    `${plural(r.chatsAdded, "chat")} added`,
    `${plural(r.filesAdded, "file")} added`,
    ...(r.chatsReplaced + r.filesReplaced > 0 ? [`${r.chatsReplaced + r.filesReplaced} replaced`] : []),
    ...(r.chatsRemoved + r.filesRemoved > 0 ? [`${r.chatsRemoved + r.filesRemoved} removed`] : []),
    `${r.skipped} skipped`,
    r.preferencesRestored ? "preferences restored" : "preferences unchanged",
  ];
  return `Restore finished: ${parts.join(", ")}.`;
}
