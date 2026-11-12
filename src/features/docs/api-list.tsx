"use client";

import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ApiIndexEntry, ApiKind } from "@/types/docs";

const KIND_LABEL: Record<ApiKind, string> = {
  function: "Functions",
  method: "Methods",
  callback: "Callbacks",
  event: "Events",
};
const KINDS: readonly ApiKind[] = ["function", "method", "callback", "event"];

interface ApiListProps {
  entries: readonly ApiIndexEntry[];
  onSelect: (documentId: number) => void;
}

/** API reference index: every indexed entry, grouped by owner (class/library), filterable by kind. */
export function ApiList({ entries, onSelect }: ApiListProps) {
  const [kind, setKind] = useState<ApiKind | null>(null);

  const counts = useMemo(() => {
    const result: Record<ApiKind, number> = { function: 0, method: 0, callback: 0, event: 0 };
    for (const entry of entries) result[entry.kind] += 1;
    return result;
  }, [entries]);

  const groups = useMemo(() => {
    const map = new Map<string, ApiIndexEntry[]>();
    for (const entry of entries) {
      if (kind && entry.kind !== kind) continue;
      const key = entry.owner ?? (entry.kind === "callback" || entry.kind === "event" ? "Callbacks & events" : "Global");
      map.set(key, [...(map.get(key) ?? []), entry]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [entries, kind]);

  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No API entries were found in the indexed pages.</p>;
  }

  return (
    <div>
      <div role="group" aria-label="Filter by kind" className="mb-3 flex flex-wrap gap-1.5">
        {[null, ...KINDS].map((k) => {
          const count = k === null ? entries.length : counts[k];
          if (k !== null && count === 0) return null;
          const active = k === kind;
          return (
            <button
              key={k ?? "all"}
              type="button"
              aria-pressed={active}
              onClick={() => setKind(k)}
              className={cn(
                "rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-accent",
                active && "bg-accent font-medium",
              )}
            >
              {k === null ? "All" : KIND_LABEL[k]} <span className="tabular-nums text-muted-foreground">{count}</span>
            </button>
          );
        })}
      </div>
      <div className="space-y-4">
        {groups.map(([owner, items]) => (
          <section key={owner} aria-label={owner}>
            <h3 className="pb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">{owner}</h3>
            <ul className="space-y-0.5">
              {items.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(entry.documentId)}
                    className="w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 break-all font-mono text-[13px]">{entry.signature}</span>
                      <Badge variant="muted" className="ml-auto shrink-0">{entry.kind}</Badge>
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {entry.description ?? entry.documentTitle}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
