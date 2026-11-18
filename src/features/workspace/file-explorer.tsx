"use client";

import { FilePlus2, FileCode2, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isDirty, type Result, type WorkspaceFile } from "@/lib/workspace/types";

interface FileExplorerProps {
  files: readonly WorkspaceFile[];
  activeId: string | null;
  onOpen(id: string): void;
  onCreate(name: string): void;
  onRename(id: string, name: string): Result<string>;
  onDelete(id: string): void;
}

/** All files in the workspace: open, create, rename and delete. */
export function FileExplorer({ files, activeId, onOpen, onCreate, onRename, onDelete }: FileExplorerProps) {
  const [creating, setCreating] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string; error: string | null } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));

  function commitRename() {
    if (!renaming) return;
    const result = onRename(renaming.id, renaming.value);
    if (result.ok) setRenaming(null);
    else setRenaming({ ...renaming, error: result.error });
  }

  return (
    <nav aria-label="Lua files" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Files ({files.length})</h2>
        <Button size="icon" variant="ghost" className="size-7" aria-label="New file" title="New file" onClick={() => setCreating("untitled")}>
          <FilePlus2 />
        </Button>
      </div>

      {creating !== null && (
        <form
          className="px-3 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            onCreate(creating);
            setCreating(null);
          }}
        >
          <input
            autoFocus
            aria-label="New file name"
            value={creating}
            onChange={(e) => setCreating(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setCreating(null)}
            onFocus={(e) => e.currentTarget.select()}
            className="h-8 w-full rounded border border-border bg-background px-2 text-sm"
          />
          <p className="mt-1 text-xs text-muted-foreground">Enter to create · Esc to cancel</p>
        </form>
      )}

      <ul className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {sorted.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">No files yet. Create one or import a .lua file.</li>}
        {sorted.map((file) => {
          const dirty = isDirty(file);
          return (
            <li key={file.id} data-testid="file-row" data-name={file.name} className={cn("group rounded", file.id === activeId && "bg-accent")}>
              {renaming?.id === file.id ? (
                <form
                  className="p-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    commitRename();
                  }}
                >
                  <input
                    autoFocus
                    aria-label={`Rename ${file.name}`}
                    value={renaming.value}
                    onChange={(e) => setRenaming({ ...renaming, value: e.target.value, error: null })}
                    onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}
                    onFocus={(e) => e.currentTarget.select()}
                    className="h-7 w-full rounded border border-border bg-background px-2 text-sm"
                  />
                  {renaming.error && (
                    <p role="alert" className="mt-1 text-xs text-destructive">
                      {renaming.error}
                    </p>
                  )}
                </form>
              ) : deleting === file.id ? (
                <div className="flex items-center gap-1 p-1 text-xs">
                  <span className="min-w-0 flex-1 truncate">Delete {file.name}?</span>
                  <Button size="sm" variant="outline" className="h-6 px-2" onClick={() => { onDelete(file.id); setDeleting(null); }}>
                    Delete
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => setDeleting(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="flex items-center">
                  <button type="button" onClick={() => onOpen(file.id)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm">
                    <FileCode2 className="size-4 shrink-0" aria-hidden="true" />
                    <span className="truncate">{file.name}</span>
                    {dirty && <span role="img" aria-label="Unsaved changes" title="Unsaved changes" data-testid="explorer-unsaved" className="size-2 shrink-0 rounded-full bg-amber-500" />}
                  </button>
                  <button type="button" aria-label={`Rename ${file.name}`} title="Rename" onClick={() => setRenaming({ id: file.id, value: file.name, error: null })} className="rounded p-1 opacity-60 hover:bg-background hover:opacity-100 focus:opacity-100">
                    <Pencil className="size-3.5" aria-hidden="true" />
                  </button>
                  <button type="button" aria-label={`Delete ${file.name}`} title="Delete" onClick={() => setDeleting(file.id)} className="mr-1 rounded p-1 opacity-60 hover:bg-background hover:opacity-100 focus:opacity-100">
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
