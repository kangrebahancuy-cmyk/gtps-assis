"use client";

import { useEffect, useState, type ComponentType } from "react";

import type { EditorEngine, EditorProps } from "./editor-types";
import { FallbackEditor } from "./fallback-editor";
import { MonacoEditor } from "./monaco-editor";
import type { MonacoReactModule, MonacoReactProps } from "./monaco-types";

export const MONACO_TIMEOUT_MS = 15_000;

let pending: Promise<ComponentType<MonacoReactProps>> | null = null;

/**
 * Loads Monaco once per page. @monaco-editor/react downloads the editor itself from a CDN at
 * runtime, so this can fail (offline, blocked, slow): the promise then rejects after `timeoutMs`
 * and the workspace falls back to the basic editor. A failed load can be retried.
 */
export function loadMonaco(timeoutMs = MONACO_TIMEOUT_MS): Promise<ComponentType<MonacoReactProps>> {
  if (!pending) {
    const attempt = (async () => {
      const mod = (await import("@monaco-editor/react")) as unknown as MonacoReactModule;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Monaco did not load in time (it is downloaded from a CDN).")), timeoutMs);
      });
      try {
        await Promise.race([mod.loader.init(), timeout]);
      } finally {
        clearTimeout(timer);
      }
      return mod.default as unknown as ComponentType<MonacoReactProps>;
    })();
    pending = attempt;
    attempt.catch(() => {
      if (pending === attempt) pending = null;
    });
  }
  return pending;
}

export interface CodeEditorProps extends EditorProps {
  /** "basic" skips Monaco entirely. */
  engine?: "auto" | "basic";
  onEngine?(engine: EditorEngine, reason: string | null): void;
  loadTimeoutMs?: number;
}

type Choice = { engine: "loading"; reason: null } | { engine: "monaco"; Editor: ComponentType<MonacoReactProps>; reason: null } | { engine: "basic"; reason: string };

/** The Lua editor: Monaco when it loads, the basic editor otherwise. Both give the workspace the same EditorHandle. */
export function CodeEditor({ engine = "auto", onEngine, loadTimeoutMs, ...props }: CodeEditorProps) {
  const [choice, setChoice] = useState<Choice>(engine === "basic" ? { engine: "basic", reason: "The basic editor was selected." } : { engine: "loading", reason: null });

  useEffect(() => {
    if (engine === "basic") {
      setChoice({ engine: "basic", reason: "The basic editor was selected." });
      return;
    }
    let cancelled = false;
    setChoice({ engine: "loading", reason: null });
    loadMonaco(loadTimeoutMs).then(
      (Editor) => !cancelled && setChoice({ engine: "monaco", Editor, reason: null }),
      (error: unknown) => !cancelled && setChoice({ engine: "basic", reason: error instanceof Error ? error.message : "Monaco could not be loaded." }),
    );
    return () => {
      cancelled = true;
    };
  }, [engine, loadTimeoutMs]);

  useEffect(() => {
    onEngine?.(choice.engine, choice.reason);
  }, [choice, onEngine]);

  return (
    <div className="h-full min-h-0" data-editor-engine={choice.engine}>
      {choice.engine === "loading" && (
        <div role="status" className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Loading editor…
        </div>
      )}
      {choice.engine === "monaco" && <MonacoEditor Editor={choice.Editor} {...props} />}
      {choice.engine === "basic" && <FallbackEditor {...props} />}
    </div>
  );
}
