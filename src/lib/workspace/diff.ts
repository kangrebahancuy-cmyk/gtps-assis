/** A line diff for previewing what an AI result would change. Pure. */

export type DiffOp = { type: "same" | "add" | "del"; text: string };

const MAX_CELLS = 4_000_000;

export function diffLines(before: string, after: string): DiffOp[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const ops: DiffOp[] = a.slice(0, head).map((text) => ({ type: "same", text }));
  if (midA.length * midB.length > MAX_CELLS) {
    // Too big for the table: show the middle as one removal and one addition (still correct, just coarser).
    ops.push(...midA.map((text): DiffOp => ({ type: "del", text })), ...midB.map((text): DiffOp => ({ type: "add", text })));
  } else {
    ops.push(...lcsDiff(midA, midB));
  }
  ops.push(...a.slice(a.length - tail).map((text): DiffOp => ({ type: "same", text })));
  return ops;
}

function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push({ type: "del", text: a[i++]! });
    } else {
      out.push({ type: "add", text: b[j++]! });
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++]! });
  while (j < m) out.push({ type: "add", text: b[j++]! });
  return out;
}

export interface DiffStats {
  added: number;
  removed: number;
  unchanged: number;
}

export const diffStats = (ops: readonly DiffOp[]): DiffStats => ({
  added: ops.filter((o) => o.type === "add").length,
  removed: ops.filter((o) => o.type === "del").length,
  unchanged: ops.filter((o) => o.type === "same").length,
});

/** The ops with long unchanged runs folded: `context` lines are kept around every change, the rest become one "skipped" marker. */
export type FoldedOp = DiffOp | { type: "skip"; count: number };

export function foldDiff(ops: readonly DiffOp[], context = 2): FoldedOp[] {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, i) => {
    if (op.type === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  });
  const out: FoldedOp[] = [];
  let skipped = 0;
  ops.forEach((op, i) => {
    if (keep[i]) {
      if (skipped > 0) out.push({ type: "skip", count: skipped });
      skipped = 0;
      out.push(op);
    } else skipped++;
  });
  if (skipped > 0) out.push({ type: "skip", count: skipped });
  return out;
}
