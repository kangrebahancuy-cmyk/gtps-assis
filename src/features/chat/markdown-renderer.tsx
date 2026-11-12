import type { MouseEvent, ReactNode } from "react";

import { CodeBlock } from "@/features/chat/code-block";
import { parseInline, parseMarkdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import type { InlineNode, MarkdownListItem, TableAlign } from "@/types";

export type LinkClickHandler = (href: string, event: MouseEvent<HTMLAnchorElement>) => void;

function renderNodes(nodes: readonly InlineNode[], onLinkClick?: LinkClickHandler): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return node.text;
      case "code":
        return (
          <code key={index} className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[0.85em]">
            {node.text}
          </code>
        );
      case "strong":
        return <strong key={index}>{renderNodes(node.children, onLinkClick)}</strong>;
      case "em":
        return <em key={index}>{renderNodes(node.children, onLinkClick)}</em>;
      case "link":
        return (
          <a
            key={index}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onLinkClick ? (event) => onLinkClick(node.href, event) : undefined}
            className="text-primary underline underline-offset-2 hover:opacity-80"
          >
            {renderNodes(node.children, onLinkClick)}
          </a>
        );
    }
  });
}

const inline = (text: string, onLinkClick?: LinkClickHandler): ReactNode[] =>
  renderNodes(parseInline(text), onLinkClick);

const HEADING_CLASS = {
  1: "text-2xl font-semibold tracking-tight mt-1 mb-3",
  2: "text-lg font-semibold mt-6 mb-2 border-b border-border pb-1",
  3: "text-base font-semibold mt-4 mb-2",
  4: "text-sm font-semibold mt-4 mb-1.5",
  5: "text-sm font-medium mt-3 mb-1",
  6: "text-xs font-medium uppercase tracking-wide mt-3 mb-1 text-muted-foreground",
} as const;

const ALIGN_CLASS: Record<NonNullable<TableAlign>, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

function renderList(
  list: { ordered: boolean; items: readonly MarkdownListItem[] },
  onLinkClick: LinkClickHandler | undefined,
  nested: boolean,
): ReactNode {
  const Tag = list.ordered ? "ol" : "ul";
  return (
    <Tag className={cn(nested ? "mt-1" : "my-2", "space-y-1 pl-5", list.ordered ? "list-decimal" : "list-disc")}>
      {list.items.map((item, index) => (
        <li key={index}>
          {inline(item.text, onLinkClick)}
          {item.children && renderList(item.children, onLinkClick, true)}
        </li>
      ))}
    </Tag>
  );
}

interface MarkdownRendererProps {
  source: string;
  className?: string;
  /** Lets the host intercept link clicks (e.g. open indexed pages inside the explorer). */
  onLinkClick?: LinkClickHandler;
}

export function MarkdownRenderer({ source, className, onLinkClick }: MarkdownRendererProps) {
  const blocks = parseMarkdown(source);

  return (
    <div className={cn("text-sm leading-relaxed", className)}>
      {blocks.map((block, index) => {
        switch (block.type) {
          case "heading": {
            const Tag = `h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
            return (
              <Tag key={index} id={block.id} className={cn(HEADING_CLASS[block.level], "scroll-mt-4")}>
                {inline(block.text, onLinkClick)}
              </Tag>
            );
          }
          case "paragraph":
            return (
              <p key={index} className="my-2">
                {inline(block.text, onLinkClick)}
              </p>
            );
          case "list":
            return <div key={index}>{renderList(block, onLinkClick, false)}</div>;
          case "code":
            return <CodeBlock key={index} code={block.code} language={block.language} />;
          case "table":
            return (
              <div key={index} className="my-3 overflow-x-auto rounded-lg border border-border scrollbar-thin">
                <table className="w-full border-collapse text-sm">
                  <thead className="bg-secondary/60">
                    <tr>
                      {block.header.map((cell, c) => (
                        <th
                          key={c}
                          scope="col"
                          className={cn("border-b border-border px-3 py-2 font-medium", ALIGN_CLASS[block.align[c] ?? "left"])}
                        >
                          {inline(cell, onLinkClick)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r} className="border-b border-border last:border-0">
                        {row.map((cell, c) => (
                          <td key={c} className={cn("px-3 py-2 align-top", ALIGN_CLASS[block.align[c] ?? "left"])}>
                            {inline(cell, onLinkClick)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
}
