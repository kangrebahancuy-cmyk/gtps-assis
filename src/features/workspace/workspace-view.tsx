"use client";

import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/features/workspace/code-editor";
import { CodePreview } from "@/features/workspace/code-preview";
import { FileTabs } from "@/features/workspace/file-tabs";
import { useHydrated } from "@/hooks/use-hydrated";
import { useWorkspaceStore } from "@/store/workspace-store";

export function WorkspaceView() {
  const hydrated = useHydrated();
  const files = useWorkspaceStore((state) => state.files);
  const activeFileId = useWorkspaceStore((state) => state.activeFileId);
  const setActiveFile = useWorkspaceStore((state) => state.setActiveFile);
  const updateFileContent = useWorkspaceStore((state) => state.updateFileContent);

  const activeFile = files.find((file) => file.id === activeFileId) ?? files[0];

  if (!hydrated || !activeFile) {
    return (
      <div
        role="status"
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
      >
        Loading workspace…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border pr-3">
        <div className="min-w-0 flex-1">
          <FileTabs
            files={files}
            activeFileId={activeFile.id}
            onSelect={setActiveFile}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled
          title="Download is not available yet"
          aria-label="Download (not available yet)"
        >
          <Download />
          Download
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 grid-rows-2 lg:grid-cols-2 lg:grid-rows-1">
        <section
          aria-label="Editor"
          className="min-h-0 border-b border-border lg:border-b-0 lg:border-r"
        >
          <CodeEditor
            key={activeFile.id}
            path={activeFile.name}
            value={activeFile.content}
            onChange={(content) => updateFileContent(activeFile.id, content)}
          />
        </section>
        <section aria-label="Code preview" className="min-h-0">
          <CodePreview content={activeFile.content} />
        </section>
      </div>
    </div>
  );
}
