/**
 * Stand-in for @monaco-editor/react in the Chromium tests (the real package, and Monaco itself, are not
 * installed here and cannot be downloaded). It is a textarea that implements the small part of the Monaco API the
 * workspace adapter uses, and records what the adapter asks of it (markers, find actions, commands), so the tests
 * check the wiring: file switching, selection, applying edits, markers, find actions, Ctrl+S.
 * It does NOT test Monaco: highlighting, the real find widget and real markers are not exercised here.
 *
 * Controls (set on `window` before the app loads): __MONACO_MODE = "ok" | "fail" | "hang".
 */
import { useEffect, useRef } from "react";

type W = Window & {
  __MONACO_MODE?: string;
  __monaco?: { loadCalls: number; markers: Record<string, unknown[]>; actions: string[]; mounts: number; paths: string[]; eolCalls: number[] };
};
const w = window as W;
const log = (w.__monaco ??= { loadCalls: 0, markers: {}, actions: [], mounts: 0, paths: [], eolCalls: [] });

const offsetOf = (text: string, line: number, column: number) => {
  let off = 0;
  for (let l = 1; l < line; l++) off = text.indexOf("\n", off) + 1;
  return off + column - 1;
};
const positionAt = (text: string, offset: number) => {
  const before = text.slice(0, offset);
  const lineNumber = before.split("\n").length;
  return { lineNumber, column: offset - (before.lastIndexOf("\n") + 1) + 1 };
};

const monacoApi = {
  editor: {
    setModelMarkers(_model: unknown, owner: string, markers: unknown[]) {
      log.markers[owner] = markers;
    },
  },
  MarkerSeverity: { Error: 8 },
  KeyMod: { CtrlCmd: 2048 },
  KeyCode: { KeyS: 49 },
};

export const loader = {
  async init() {
    log.loadCalls += 1;
    if (w.__MONACO_MODE === "fail") throw new Error("Could not download Monaco from the CDN (simulated).");
    if (w.__MONACO_MODE === "hang") return new Promise<never>(() => {});
    return monacoApi;
  },
};

type Props = { value?: string; path?: string; onChange?: (v: string | undefined) => void; onMount?: (editor: unknown, monaco: unknown) => void; theme?: string; language?: string; options?: { ariaLabel?: string } };

export default function Editor({ value = "", path = "", onChange, onMount, theme, language, options }: Props) {
  const area = useRef<HTMLTextAreaElement>(null);
  const latest = useRef({ onChange, value });
  latest.current = { onChange, value };
  const commands = useRef<Array<{ key: number; run: () => void }>>([]);
  const listeners = useRef<Array<() => void>>([]);

  useEffect(() => {
    log.paths.push(path);
  }, [path]);

  useEffect(() => {
    const el = area.current!;
    log.mounts += 1;
    const model = {
      getOffsetAt: (p: { lineNumber: number; column: number }) => offsetOf(el.value, p.lineNumber, p.column),
      getPositionAt: (o: number) => positionAt(el.value, o),
      getValueInRange: (r: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }) => el.value.slice(offsetOf(el.value, r.startLineNumber, r.startColumn), offsetOf(el.value, r.endLineNumber, r.endColumn)),
      getLineMaxColumn: (line: number) => (el.value.split("\n")[line - 1]?.length ?? 0) + 1,
      getLineCount: () => el.value.split("\n").length,
      setEOL: (eol: number) => void log.eolCalls.push(eol),
    };
    const range = (a: number, b: number) => {
      const s = positionAt(el.value, Math.min(a, b));
      const e = positionAt(el.value, Math.max(a, b));
      return { startLineNumber: s.lineNumber, startColumn: s.column, endLineNumber: e.lineNumber, endColumn: e.column, getStartPosition: () => ({ lineNumber: s.lineNumber, column: s.column }), getEndPosition: () => ({ lineNumber: e.lineNumber, column: e.column }) };
    };
    const editor = {
      getModel: () => model,
      getSelection: () => range(el.selectionStart, el.selectionEnd),
      getValue: () => el.value,
      focus: () => el.focus(),
      revealLineInCenter: () => {},
      setPosition: (p: { lineNumber: number; column: number }) => {
        const at = offsetOf(el.value, p.lineNumber, p.column);
        el.setSelectionRange(at, at);
      },
      executeEdits(_source: string, edits: Array<{ range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; text: string }>) {
        let text = el.value;
        for (const e of edits) {
          const s = offsetOf(text, e.range.startLineNumber, e.range.startColumn);
          const n = offsetOf(text, e.range.endLineNumber, e.range.endColumn);
          text = text.slice(0, s) + e.text + text.slice(n);
        }
        el.value = text;
        latest.current.onChange?.(text); // like Monaco: an edit made through the API reports a change
        return true;
      },
      pushUndoStop: () => true,
      getAction: (id: string) => ({ run: async () => void log.actions.push(id) }),
      addCommand: (key: number, run: () => void) => (commands.current.push({ key, run }), "cmd"),
      onDidChangeCursorSelection: (fn: () => void) => (listeners.current.push(fn), { dispose: () => void (listeners.current = listeners.current.filter((l) => l !== fn)) }),
    };
    // Monaco reports cursor/selection changes however they happen, including programmatic ones.
    const notify = () => listeners.current.forEach((l) => l());
    el.addEventListener("select", notify);
    document.addEventListener("selectionchange", notify);
    onMount?.(editor, monacoApi);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fire = () => listeners.current.forEach((l) => l());
  return (
    <div data-testid="monaco-stub" data-path={path} data-theme={theme} data-language={language}>
      <textarea
        ref={area}
        aria-label={options?.ariaLabel ?? "Editor"}
        data-testid="monaco-stub-input"
        value={value}
        onChange={(e) => {
          latest.current.onChange?.(e.target.value);
          fire();
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") commands.current.find((c) => c.key === (2048 | 49))?.run();
        }}
        style={{ width: "100%", height: 300 }}
      />
    </div>
  );
}
