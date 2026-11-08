import { FileCode2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { LuaFile } from "@/types";

interface FileTabsProps {
  files: readonly LuaFile[];
  activeFileId: string;
  onSelect: (id: string) => void;
}

export function FileTabs({ files, activeFileId, onSelect }: FileTabsProps) {
  return (
    <div
      role="tablist"
      aria-label="Open files"
      className="flex overflow-x-auto border-b border-border scrollbar-thin"
    >
      {files.map((file) => {
        const active = file.id === activeFileId;
        return (
          <button
            key={file.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(file.id)}
            className={cn(
              "flex shrink-0 items-center gap-2 border-b-2 border-transparent px-4 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground",
              active && "border-primary text-foreground",
            )}
          >
            <FileCode2 className="size-4" aria-hidden="true" />
            {file.name}
          </button>
        );
      })}
    </div>
  );
}
