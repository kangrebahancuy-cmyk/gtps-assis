/**
 * The small part of Monaco / @monaco-editor/react that the adapter uses, written as plain
 * structural types. The adapter is written against these so it compiles without the package
 * installed; the real package provides a superset at runtime.
 */
export interface MonacoPosition {
  lineNumber: number;
  column: number;
}
export interface MonacoRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}
export interface MonacoModelLike {
  getOffsetAt(position: MonacoPosition): number;
  getPositionAt(offset: number): MonacoPosition;
  getValueInRange(range: MonacoRange): string;
  getLineMaxColumn(line: number): number;
  getLineCount(): number;
  setEOL(eol: number): void;
}
export interface MonacoSelectionLike extends MonacoRange {
  getStartPosition(): MonacoPosition;
  getEndPosition(): MonacoPosition;
}
export interface MonacoEditorLike {
  getModel(): MonacoModelLike | null;
  getSelection(): MonacoSelectionLike | null;
  getValue(): string;
  focus(): void;
  revealLineInCenter(line: number): void;
  setPosition(position: MonacoPosition): void;
  executeEdits(source: string, edits: Array<{ range: MonacoRange; text: string; forceMoveMarkers?: boolean }>): boolean;
  pushUndoStop(): boolean;
  getAction(id: string): { run(): Promise<void> } | null;
  addCommand(keybinding: number, handler: () => void): string | null;
  onDidChangeCursorSelection(listener: () => void): { dispose(): void };
}
export interface MonacoMarker extends MonacoRange {
  severity: number;
  message: string;
  source?: string;
}
export interface MonacoLike {
  editor: { setModelMarkers(model: MonacoModelLike, owner: string, markers: MonacoMarker[]): void };
  MarkerSeverity: { Error: number };
  KeyMod: { CtrlCmd: number };
  KeyCode: { KeyS: number };
}

/** Props of the `Editor` component from @monaco-editor/react that we pass. */
export interface MonacoReactProps {
  height?: string;
  language?: string;
  path?: string;
  theme?: string;
  value?: string;
  onChange?: (value: string | undefined) => void;
  onMount?: (editor: MonacoEditorLike, monaco: MonacoLike) => void;
  options?: Record<string, unknown>;
  loading?: unknown;
}

export interface MonacoReactModule {
  default: (props: MonacoReactProps) => unknown;
  loader: { init(): Promise<MonacoLike> };
}
