"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { deleteChatDatabase } from "@/lib/chat/idb-repository";
import { deleteWorkspaceDatabase } from "@/lib/workspace/idb-repository";
import { clearLocalData, getLocalDataSize } from "@/services/storage";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function LocalDataPanel() {
  // Read lazily on the client; the server render shows no size.
  const [size, setSize] = useState<number | null>(null);

  function handleRefresh() {
    setSize(getLocalDataSize());
  }

  async function handleClear() {
    const confirmed = window.confirm(
      "Delete all chats, workspace files, and settings stored in this browser?",
    );
    if (!confirmed) return;
    clearLocalData();
    await Promise.all([deleteChatDatabase(), deleteWorkspaceDatabase()]); // chat history and Lua workspace files live in IndexedDB
    // Reload so in-memory state matches the now-empty storage.
    window.location.reload();
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Stored in this browser</p>
            <p className="text-sm text-muted-foreground">
              Chat history and Lua workspace files (both IndexedDB), and interface preferences. The size shown covers localStorage only.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm tabular-nums text-muted-foreground">
              {size === null ? "-" : formatBytes(size)}
            </span>
            <Button variant="outline" size="sm" onClick={handleRefresh}>
              Check size
            </Button>
          </div>
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
          <div>
            <p className="text-sm font-medium">Clear local data</p>
            <p className="text-sm text-muted-foreground">
              This cannot be undone.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void handleClear()}>
            Clear data
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
