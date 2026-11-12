import type { SnippetSegment } from "@/types/docs";

/** Search-result text with the matching words highlighted (rendered as elements, never raw HTML). */
export function Snippet({ segments }: { segments: readonly SnippetSegment[] }) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.match ? (
          <mark key={index} className="rounded bg-yellow-300/60 px-0.5 text-foreground dark:bg-yellow-500/30">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}
