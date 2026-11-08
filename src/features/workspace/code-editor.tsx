"use client";

import dynamic from "next/dynamic";

import { useUiStore } from "@/store/ui-store";

/**
 * Monaco is loaded lazily on the client only. By default the loader fetches
 * the editor assets from a CDN at runtime, so the editor needs internet access
 * in the browser (see README).
 */
const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div
      role="status"
      className="flex h-full items-center justify-center text-sm text-muted-foreground"
    >
      Loading editor…
    </div>
  ),
});

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: string;
  path?: string;
}

export function CodeEditor({
  value,
  onChange,
  language = "lua",
  path,
}: CodeEditorProps) {
  const theme = useUiStore((state) => state.theme);

  return (
    <MonacoEditor
      height="100%"
      language={language}
      path={path}
      theme={theme === "dark" ? "vs-dark" : "light"}
      value={value}
      onChange={(next) => onChange(next ?? "")}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        padding: { top: 12 },
      }}
    />
  );
}
