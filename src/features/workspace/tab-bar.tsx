import { FileCode2, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { isDirty, type WorkspaceFile } from "@/lib/workspace/types";

interface TabBarProps {
  files: readonly WorkspaceFile[];
  tabs: readonly string[];
  activeId: string | null;
  onSelect(id: string): void;
  onClose(id: string): void;
}

/** Open files as tabs. A dot marks a file with unsaved changes; closing a tab keeps its unsaved text. */
export function TabBar({ files, tabs, activeId, onSelect, onClose }: TabBarProps) {
  const open = tabs.map((id) => files.find((f) => f.id === id)).filter((f): f is WorkspaceFile => f !== undefined);
  return (
    <div role="tablist" aria-label="Open files" className="flex min-h-9 overflow-x-auto border-b border-border scrollbar-thin">
      {open.length === 0 && <span className="px-4 py-2 text-sm text-muted-foreground">No file open</span>}
      {open.map((file) => {
        const active = file.id === activeId;
        const dirty = isDirty(file);
        return (
          <div key={file.id} className={cn("flex shrink-0 items-center border-b-2 border-transparent text-sm", active ? "border-primary text-foreground" : "text-muted-foreground hover:text-foreground")}>
            <button type="button" role="tab" aria-selected={active} data-testid="tab" data-dirty={dirty} onClick={() => onSelect(file.id)} className="flex items-center gap-2 py-2 pl-3 pr-1">
              <FileCode2 className="size-4" aria-hidden="true" />
              {file.name}
              {dirty && (
                <span data-testid="unsaved-dot" role="img" aria-label="Unsaved changes" title="Unsaved changes" className="size-2 rounded-full bg-amber-500" />
              )}
            </button>
            <button type="button" aria-label={`Close ${file.name}`} onClick={() => onClose(file.id)} className="mr-1 rounded p-1 hover:bg-accent">
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
