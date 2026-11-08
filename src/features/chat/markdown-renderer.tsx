import type { ReactNode } from "react";

import { CodeBlock } from "@/features/chat/code-block";
import { parseMarkdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";

const INLINE_PATTERN = /(`[^`]+`|\*\*[^*]+\*\*)/g;

/** Renders **bold** and `code` spans as React elements (never raw HTML). */
function renderInline(text: string): ReactNode[] {
  return text.split(INLINE_PATTERN).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code
          key={index}
          className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[0.85em]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

interface MarkdownRendererProps {
  source: string;
  className?: string;
}

export function MarkdownRenderer({ source, className }: MarkdownRendererProps) {
  const blocks = parseMarkdown(source);

  return (
    <div className={cn("text-sm leading-relaxed", className)}>
      {blocks.map((block, index) => {
        switch (block.type) {
          case "heading": {
            const sizes = {
              1: "text-2xl font-semibold tracking-tight mt-1 mb-3",
              2: "text-lg font-semibold mt-6 mb-2",
              3: "text-base font-semibold mt-4 mb-2",
            } as const;
            const Tag = `h${block.level}` as "h1" | "h2" | "h3";
            return (
              <Tag key={index} className={sizes[block.level]}>
                {renderInline(block.text)}
              </Tag>
            );
          }
          case "paragraph":
            return (
              <p key={index} className="my-2">
                {renderInline(block.text)}
              </p>
            );
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag
                key={index}
                className={cn(
                  "my-2 space-y-1 pl-5",
                  block.ordered ? "list-decimal" : "list-disc",
                )}
              >
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{renderInline(item)}</li>
                ))}
              </Tag>
            );
          }
          case "code":
            return (
              <CodeBlock
                key={index}
                code={block.code}
                language={block.language}
              />
            );
        }
      })}
    </div>
  );
}
