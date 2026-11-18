import { diffLines, diffStats, foldDiff } from "@/lib/workspace/diff";
import { cn } from "@/lib/utils";

/** A line diff of what an AI result would change (unchanged runs are folded). */
export function DiffView({ before, after }: { before: string; after: string }) {
  const ops = diffLines(before, after);
  const stats = diffStats(ops);
  return (
    <div data-testid="diff">
      <p className="mb-1 text-xs text-muted-foreground" data-testid="diff-stats">
        <span className="text-green-600">+{stats.added}</span> <span className="text-destructive">−{stats.removed}</span> lines · {stats.unchanged} unchanged
      </p>
      <pre className="max-h-64 overflow-auto rounded border border-border bg-background/60 p-2 font-mono text-[11px] leading-snug">
        {foldDiff(ops).map((op, i) =>
          op.type === "skip" ? (
            <div key={i} className="text-muted-foreground">
              ⋯ {op.count} unchanged line{op.count === 1 ? "" : "s"}
            </div>
          ) : (
            <div key={i} data-diff={op.type} className={cn("whitespace-pre", op.type === "add" && "bg-green-500/15 text-green-700 dark:text-green-300", op.type === "del" && "bg-destructive/15 text-destructive")}>
              {op.type === "add" ? "+ " : op.type === "del" ? "- " : "  "}
              {op.text}
            </div>
          ),
        )}
      </pre>
    </div>
  );
}
