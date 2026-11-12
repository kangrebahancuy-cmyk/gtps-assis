"use client";

import { HighlightedCode } from "@/features/chat/code-block";
import type { ExampleIndexEntry } from "@/types/docs";

const PREVIEW_LINES = 8;

interface ExamplesListProps {
  examples: readonly ExampleIndexEntry[];
  onSelect: (documentId: number) => void;
}

/** Every Lua code example in the index, with the page it comes from. */
export function ExamplesList({ examples, onSelect }: ExamplesListProps) {
  if (examples.length === 0) {
    return <p className="text-sm text-muted-foreground">No Lua examples were found in the indexed pages.</p>;
  }
  return (
    <ul className="space-y-3">
      {examples.map((example) => {
        const lines = example.code.split("\n");
        const preview = lines.slice(0, PREVIEW_LINES).join("\n");
        return (
          <li key={example.id} className="rounded-lg border border-border">
            <button
              type="button"
              onClick={() => onSelect(example.documentId)}
              className="block w-full rounded-t-lg px-3 py-2 text-left text-sm hover:bg-accent"
            >
              <span className="font-medium">{example.documentTitle}</span>
              {example.context && example.context !== example.documentTitle && (
                <span className="text-muted-foreground"> · {example.context}</span>
              )}
            </button>
            <pre className="overflow-x-auto border-t border-border bg-secondary/40 p-3 font-mono text-xs leading-relaxed scrollbar-thin">
              <HighlightedCode code={preview} language={example.language} />
            </pre>
            {lines.length > PREVIEW_LINES && (
              <p className="px-3 py-1 text-[11px] text-muted-foreground">
                {lines.length - PREVIEW_LINES} more line{lines.length - PREVIEW_LINES === 1 ? "" : "s"} on the page
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
