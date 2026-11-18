"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import { LOADING_STATE, WorkspaceController, type WorkspaceState } from "@/lib/workspace/controller";
import { openWorkspaceRepository } from "@/lib/workspace/idb-repository";
import { readLegacyWorkspace } from "@/lib/workspace/legacy";

const WorkspaceContext = createContext<WorkspaceController | null>(null);

const noSubscription = () => () => {};
const loading = () => LOADING_STATE;

/**
 * Opens the workspace storage once in the browser (IndexedDB, or memory if it is unavailable) and
 * shares the engine with the Lua workspace page and the chat's "Open in Lua Workspace" button.
 * Pass `controller` to supply your own (tests).
 */
export function WorkspaceProvider({ children, controller }: { children: ReactNode; controller?: WorkspaceController }) {
  const [workspace, setWorkspace] = useState<WorkspaceController | null>(controller ?? null);

  useEffect(() => {
    if (controller) {
      setWorkspace(controller);
      void controller.init();
      return;
    }
    let cancelled = false;
    let created: WorkspaceController | null = null;
    void openWorkspaceRepository().then(({ repository, fallbackReason }) => {
      if (cancelled) {
        repository.close();
        return;
      }
      created = new WorkspaceController({ repository, fallbackReason, seedFiles: readLegacyWorkspace() });
      setWorkspace(created);
      void created.init();
    });
    return () => {
      cancelled = true;
      created?.dispose();
    };
  }, [controller]);

  // Unsaved edits are written to storage as you type; make sure the last ones are flushed when the tab is hidden or closed.
  useEffect(() => {
    if (!workspace) return;
    const flush = () => void workspace.flush();
    const onHide = () => document.visibilityState === "hidden" && flush();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [workspace]);

  return <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>;
}

/** Current workspace state, and the engine to call (null until the browser has opened the storage). */
export function useWorkspace(): { state: WorkspaceState; workspace: WorkspaceController | null } {
  const workspace = useContext(WorkspaceContext);
  const state = useSyncExternalStore(workspace ? workspace.subscribe : noSubscription, workspace ? workspace.getState : loading, loading);
  return { state, workspace };
}
