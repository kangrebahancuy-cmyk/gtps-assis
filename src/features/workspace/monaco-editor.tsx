"use client";

import { useEffect, useRef, type ComponentType } from "react";

import type { SyntaxProblem } from "@/lib/workspace/validation";
import type { EditorHandle, EditorProps, EditorSelection } from "./editor-types";
import type { MonacoEditorLike, MonacoLike, MonacoReactProps } from "./monaco-types";

const MARKER_OWNER = "gtps-syntax";

/**
 * Adapter between Monaco (via @monaco-editor/react) and the workspace's EditorHandle.
 * Lua highlighting, line numbers, the find/replace widget, undo history per file and multi-cursor
 * selection all come from Monaco itself. This component only wires it to the workspace.
 */
export function MonacoEditor({ Editor, ...props }: EditorProps & { Editor: ComponentType<MonacoReactProps> }) {
  const { path, value, onChange, onSave, onReady, onSelection, problems, theme } = props;
  const instance = useRef<{ editor: MonacoEditorLike; monaco: MonacoLike } | null>(null);
  // Callbacks change on every render; Monaco keeps the first one it was given, so go through refs.
  const latest = useRef({ onSave, onSelection });
  latest.current = { onSave, onSelection };

  useEffect(() => {
    const current = instance.current;
    const model = current?.editor.getModel();
    if (!current || !model) return;
    model.setEOL(0); // LF: the workspace stores "\n" only (Monaco would otherwise follow the OS default)
    current.monaco.editor.setModelMarkers(model, MARKER_OWNER, problems.map((p) => toMarker(p, current.monaco, model.getLineMaxColumn(Math.min(p.line, model.getLineCount())))));
  }, [problems, path]);

  useEffect(() => () => onReady(null), [onReady]);

  return (
    <Editor
      height="100%"
      language="lua"
      path={path}
      theme={theme === "dark" ? "vs-dark" : "light"}
      value={value}
      onChange={(next) => onChange(next ?? "")}
      onMount={(editor, monaco) => {
        instance.current = { editor, monaco };
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => latest.current.onSave());
        editor.onDidChangeCursorSelection(() => latest.current.onSelection(readSelection(editor)));
        editor.getModel()?.setEOL(0);
        onReady(handleFor(editor));
        latest.current.onSelection(readSelection(editor));
      }}
      options={{
        minimap: { enabled: false },
        lineNumbers: "on",
        fontSize: 13,
        tabSize: 2,
        insertSpaces: true,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        padding: { top: 12 },
        renderWhitespace: "selection",
        wordWrap: "off",
        ariaLabel: "Lua code editor",
      }}
    />
  );
}

function toMarker(p: SyntaxProblem, monaco: MonacoLike, endColumn: number) {
  return {
    severity: monaco.MarkerSeverity.Error,
    message: p.message,
    source: "Lua syntax",
    startLineNumber: p.line,
    startColumn: p.column,
    endLineNumber: p.line,
    endColumn: Math.max(endColumn, p.column + 1),
  };
}

function readSelection(editor: MonacoEditorLike): EditorSelection {
  const model = editor.getModel();
  const sel = editor.getSelection();
  if (!model || !sel) return { start: 0, end: 0, text: "" };
  const a = model.getOffsetAt(sel.getStartPosition());
  const b = model.getOffsetAt(sel.getEndPosition());
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  return { start, end, text: start === end ? "" : model.getValueInRange(sel) };
}

function handleFor(editor: MonacoEditorLike): EditorHandle {
  return {
    getValue: () => editor.getValue(),
    getSelection: () => readSelection(editor),
    replaceRange(start, end, text) {
      const model = editor.getModel();
      if (!model) return;
      const from = model.getPositionAt(start);
      const to = model.getPositionAt(end);
      editor.pushUndoStop();
      editor.executeEdits("workspace-ai", [{ range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }, text, forceMoveMarkers: true }]);
      editor.pushUndoStop();
    },
    focus: () => editor.focus(),
    openFind(replace) {
      editor.focus();
      void editor.getAction(replace ? "editor.action.startFindReplace" : "actions.find")?.run();
    },
    revealLine(line, column = 1) {
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column });
      editor.focus();
    },
  };
}
