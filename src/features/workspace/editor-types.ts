import type { SyntaxProblem } from "@/lib/workspace/validation";

export interface EditorSelection {
  /** Character offsets into the text (start <= end). start === end means no selection (just a cursor). */
  start: number;
  end: number;
  text: string;
}

/**
 * What the workspace needs from an editor. Monaco and the basic textarea editor both implement it,
 * so the toolbar, the AI panel and the tests never depend on which one is running.
 */
export interface EditorHandle {
  getValue(): string;
  getSelection(): EditorSelection;
  /** Replaces [start, end) as ONE undoable edit (Ctrl+Z restores it). */
  replaceRange(start: number, end: number, text: string): void;
  focus(): void;
  /** Opens the editor's find (or find-and-replace) widget. */
  openFind(replace: boolean): void;
  revealLine(line: number, column?: number): void;
}

export type EditorEngine = "loading" | "monaco" | "basic";

export interface EditorProps {
  /** Stable per file (the file id): the editor keeps one undo history per path. */
  path: string;
  value: string;
  onChange(text: string): void;
  onSave(): void;
  onReady(handle: EditorHandle | null): void;
  onSelection(selection: EditorSelection): void;
  problems: readonly SyntaxProblem[];
  theme: "dark" | "light" | "high-contrast";
  /** Pixels. Defaults to 13. */
  fontSize?: number;
}
