"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { findAll, offsetOfLine, pickMatch, replaceAll } from "@/lib/workspace/find";
import { cn } from "@/lib/utils";
import type { EditorHandle, EditorProps } from "./editor-types";

/** Line height for a font size (20px at the default 13px). Both the gutter and the textarea use it so numbers stay aligned. */
const lineHeightFor = (fontSize: number): number => Math.round(fontSize * 1.54);

/**
 * The basic editor: a plain textarea with line numbers, Tab indentation, Ctrl/Cmd+S and its own
 * find and replace. It is used when Monaco cannot be loaded (for example no access to the CDN it
 * is served from). It has NO syntax highlighting; syntax errors are listed in the Problems panel.
 */
export function FallbackEditor({ path, value, onChange, onSave, onReady, onSelection, problems, theme, fontSize = 13 }: EditorProps) {
  const LINE_HEIGHT = lineHeightFor(fontSize);
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const [find, setFind] = useState<{ open: boolean; replace: boolean }>({ open: false, replace: false });
  const lineCount = useMemo(() => value.split("\n").length, [value]);
  const errorLines = useMemo(() => new Set(problems.map((p) => p.line)), [problems]);

  // The callbacks change on every render of the parent; the handle given to the parent must not.
  const latest = useRef({ onChange, onSelection });
  latest.current = { onChange, onSelection };

  const emitSelection = useCallback(() => {
    const el = area.current;
    if (!el) return;
    const start = Math.min(el.selectionStart, el.selectionEnd);
    const end = Math.max(el.selectionStart, el.selectionEnd);
    latest.current.onSelection({ start, end, text: el.value.slice(start, end) });
  }, []);

  const replaceRange = useCallback(
    (start: number, end: number, text: string) => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(start, end);
      // execCommand keeps the browser's own undo stack (Ctrl+Z works); the fallback sets the value directly.
      let ok = false;
      try {
        ok = document.execCommand("insertText", false, text);
      } catch {
        ok = false;
      }
      if (!ok || el.value.slice(start, start + text.length) !== text) {
        el.setRangeText(text, start, end, "end");
        latest.current.onChange(el.value);
      }
      emitSelection();
    },
    [emitSelection],
  );

  const handle = useMemo<EditorHandle>(
    () => ({
      getValue: () => area.current?.value ?? "",
      getSelection: () => {
        const el = area.current;
        if (!el) return { start: 0, end: 0, text: "" };
        const start = Math.min(el.selectionStart, el.selectionEnd);
        const end = Math.max(el.selectionStart, el.selectionEnd);
        return { start, end, text: el.value.slice(start, end) };
      },
      replaceRange,
      focus: () => area.current?.focus(),
      openFind: (replace) => setFind({ open: true, replace }),
      revealLine(line, column = 1) {
        const el = area.current;
        if (!el) return;
        const at = offsetOfLine(el.value, line, column);
        el.focus();
        el.setSelectionRange(at, at);
        el.scrollTop = Math.max(0, (line - 3) * LINE_HEIGHT);
        emitSelection();
      },
    }),
    [replaceRange, emitSelection],
  );

  useEffect(() => {
    onReady(handle);
    return () => onReady(null);
  }, [handle, onReady]);

  // The selection can also change without the mouse or keyboard (a script, an extension, assistive technology);
  // React's onSelect does not report those, the browser's own events do.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.addEventListener("select", emitSelection);
    document.addEventListener("selectionchange", emitSelection);
    return () => {
      el.removeEventListener("select", emitSelection);
      document.removeEventListener("selectionchange", emitSelection);
    };
  }, [emitSelection]);

  // A different file: forget the old cursor, show the new text from the top.
  useLayoutEffect(() => {
    const el = area.current;
    if (el) {
      el.scrollTop = 0;
      el.setSelectionRange(0, 0);
    }
    emitSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      onSave();
    } else if (mod && event.key.toLowerCase() === "f") {
      event.preventDefault();
      setFind({ open: true, replace: false });
    } else if (mod && event.key.toLowerCase() === "h") {
      event.preventDefault();
      setFind({ open: true, replace: true });
    } else if (event.key === "Tab" && !event.shiftKey && !mod && !event.altKey) {
      event.preventDefault();
      const { selectionStart: s, selectionEnd: e } = event.currentTarget;
      replaceRange(s, e, "  ");
    }
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col", theme === "dark" ? "bg-[#1e1e1e] text-[#d4d4d4]" : theme === "high-contrast" ? "bg-black text-white" : "bg-white text-neutral-900")}
      data-editor-theme={theme}>
      {find.open && <FindBar lineHeight={LINE_HEIGHT} text={value} replaceMode={find.replace} area={area} replaceRange={replaceRange} onClose={() => { setFind({ open: false, replace: false }); area.current?.focus(); }} />}
      <div className="flex min-h-0 flex-1">
        <div
          ref={gutter}
          aria-hidden="true"
          data-testid="line-numbers"
          className="select-none overflow-hidden py-3 pl-2 pr-3 text-right font-mono text-neutral-500"
          style={{ lineHeight: `${LINE_HEIGHT}px`, fontSize: `${Math.max(9, fontSize - 1)}px` }}
        >
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i} className={cn(errorLines.has(i + 1) && "font-bold text-red-400")}>
              {i + 1}
            </div>
          ))}
        </div>
        <textarea
          ref={area}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onKeyUp={emitSelection}
          onMouseUp={emitSelection}
          onScroll={(e) => {
            if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          aria-label="Lua code editor"
          data-testid="basic-editor"
          className="min-h-0 flex-1 resize-none overflow-auto bg-transparent py-3 pr-3 font-mono outline-none"
          data-font-size={fontSize}
          style={{ lineHeight: `${LINE_HEIGHT}px`, fontSize: `${fontSize}px`, tabSize: 2 }}
        />
      </div>
    </div>
  );
}

function FindBar({ lineHeight, text, replaceMode, area, replaceRange, onClose }: { lineHeight: number; text: string; replaceMode: boolean; area: React.RefObject<HTMLTextAreaElement | null>; replaceRange: (s: number, e: number, t: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const matches = useMemo(() => findAll(text, query, caseSensitive), [text, query, caseSensitive]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  function go(backwards: boolean) {
    const el = area.current;
    if (!el) return;
    const from = backwards ? el.selectionStart : el.selectionEnd;
    const at = pickMatch(matches, from, backwards);
    if (at === null) return;
    el.setSelectionRange(at, at + query.length);
    const { line } = lineOf(el.value, at);
    el.scrollTop = Math.max(0, (line - 4) * lineHeight);
  }
  function replaceCurrent() {
    const el = area.current;
    if (!el || query === "") return;
    const selected = el.value.slice(el.selectionStart, el.selectionEnd);
    const isMatch = caseSensitive ? selected === query : selected.toLowerCase() === query.toLowerCase();
    if (isMatch) replaceRange(el.selectionStart, el.selectionEnd, replacement);
    go(false);
  }
  function replaceEverything() {
    const { text: next, count } = replaceAll(text, query, replacement, caseSensitive);
    if (count > 0) replaceRange(0, text.length, next);
  }

  return (
    <div role="search" aria-label="Find and replace" className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs text-foreground">
      <input
        ref={input}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") go(e.shiftKey);
          if (e.key === "Escape") onClose();
        }}
        placeholder="Find"
        aria-label="Find"
        className="h-7 w-40 rounded border border-border bg-background px-2"
      />
      {replaceMode && (
        <input
          value={replacement}
          onChange={(e) => setReplacement(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
          placeholder="Replace with"
          aria-label="Replace with"
          className="h-7 w-40 rounded border border-border bg-background px-2"
        />
      )}
      <span aria-live="polite" data-testid="find-count" className="text-muted-foreground">
        {query === "" ? "" : matches.length === 1 ? "1 match" : `${matches.length} matches`}
      </span>
      <Button size="sm" variant="outline" onClick={() => go(true)} disabled={matches.length === 0} aria-label="Previous match">Prev</Button>
      <Button size="sm" variant="outline" onClick={() => go(false)} disabled={matches.length === 0} aria-label="Next match">Next</Button>
      {replaceMode && (
        <>
          <Button size="sm" variant="outline" onClick={replaceCurrent} disabled={matches.length === 0}>Replace</Button>
          <Button size="sm" variant="outline" onClick={replaceEverything} disabled={matches.length === 0}>Replace all</Button>
        </>
      )}
      <label className="flex items-center gap-1 text-muted-foreground">
        <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} /> Match case
      </label>
      <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close find">Close</Button>
    </div>
  );
}

function lineOf(text: string, offset: number): { line: number } {
  return { line: text.slice(0, offset).split("\n").length };
}
