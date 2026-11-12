"use client";

import { ChevronDown, ChevronRight, FileText, Folder } from "lucide-react";
import { useEffect, useState } from "react";

import { pathToDocument } from "@/lib/doc-tree";
import { cn } from "@/lib/utils";
import type { DocTreeNode } from "@/types/docs";

interface DocTreeProps {
  roots: readonly DocTreeNode[];
  selectedId: number | null;
  onSelect: (documentId: number) => void;
}

interface NodeProps {
  node: DocTreeNode;
  depth: number;
  expanded: ReadonlySet<string>;
  toggle: (id: string) => void;
  selectedId: number | null;
  onSelect: (documentId: number) => void;
}

function TreeNode({ node, depth, expanded, toggle, selectedId, onSelect }: NodeProps) {
  const hasChildren = node.children.length > 0;
  const open = expanded.has(node.id);
  const active = node.documentId !== null && node.documentId === selectedId;
  const indent = { paddingLeft: `${depth * 12 + 4}px` };

  if (!hasChildren && node.documentId !== null) {
    return (
      <li>
        <button
          type="button"
          style={indent}
          onClick={() => onSelect(node.documentId as number)}
          aria-current={active ? "page" : undefined}
          className={cn(
            "flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-sm transition-colors hover:bg-accent",
            active && "bg-accent font-medium",
          )}
        >
          <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 break-words">{node.label}</span>
        </button>
      </li>
    );
  }

  return (
    <li>
      <div className={cn("flex items-center rounded-md hover:bg-accent", active && "bg-accent")} style={indent}>
        <button
          type="button"
          onClick={() => toggle(node.id)}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${node.label}`}
          className="flex size-6 shrink-0 items-center justify-center text-muted-foreground"
        >
          {open ? <ChevronDown className="size-3.5" aria-hidden="true" /> : <ChevronRight className="size-3.5" aria-hidden="true" />}
        </button>
        <button
          type="button"
          onClick={() => (node.documentId !== null ? onSelect(node.documentId) : toggle(node.id))}
          aria-current={active ? "page" : undefined}
          className={cn("flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-2 text-left text-sm", active ? "font-medium" : "font-medium text-foreground/90")}
        >
          <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 break-words">{node.label}</span>
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">{node.pageCount}</span>
        </button>
      </div>
      {open && (
        <ul>
          {node.children.map((child) => (
            <TreeNode key={child.id} node={child} depth={depth + 1} expanded={expanded} toggle={toggle} selectedId={selectedId} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** The documentation hierarchy exactly as indexed: categories, subcategories, then pages. */
export function DocTree({ roots, selectedId, onSelect }: DocTreeProps) {
  // Top level open, plus every ancestor of the selected page so it is visible on first render.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => {
    const open = new Set(roots.map((r) => r.id));
    for (const id of (selectedId === null ? null : pathToDocument(roots, selectedId))?.slice(0, -1) ?? []) open.add(id);
    return open;
  });

  // Keep the selected page visible: open every ancestor of it.
  useEffect(() => {
    if (selectedId === null) return;
    const path = pathToDocument(roots, selectedId);
    if (!path) return;
    setExpanded((current) => {
      const next = new Set(current);
      for (const id of path.slice(0, -1)) next.add(id);
      return next.size === current.size ? current : next;
    });
  }, [roots, selectedId]);

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (roots.length === 0) {
    return <p className="text-sm text-muted-foreground">No documents are indexed yet. Run a synchronization first.</p>;
  }
  return (
    <ul aria-label="Documentation hierarchy" className="space-y-0.5">
      {roots.map((node) => (
        <TreeNode key={node.id} node={node} depth={0} expanded={expanded} toggle={toggle} selectedId={selectedId} onSelect={onSelect} />
      ))}
    </ul>
  );
}
