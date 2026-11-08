import type { SyncStatus } from "@/types/sync";

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function Tile({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-lg font-semibold tabular-nums">{value}</dd>
      {hint && <p className="truncate text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  completed: "completed",
  completed_with_errors: "completed with errors",
  cancelled: "cancelled",
  failed: "failed",
  interrupted: "interrupted",
  running: "running",
};

export function SyncStats({ status }: { status: SyncStatus }) {
  const { current, lastRun, totals } = status;
  const counts = current?.counts ?? lastRun?.counts;
  const source = current
    ? `Current ${current.mode} run`
    : lastRun
      ? `Last run: ${lastRun.mode}, ${STATUS_LABEL[lastRun.status] ?? lastRun.status}`
      : "No synchronization has run yet";
  const dash = (n: number | undefined) => (counts ? (n ?? 0) : "-");

  return (
    <div className="mt-3">
      <p className="mb-2 text-xs text-muted-foreground">
        Change counts: {source}
        {!current && lastRun?.finishedAt ? ` (${formatTime(lastRun.finishedAt)})` : ""}
      </p>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Total documents" value={totals.documents} />
        <Tile label="New" value={dash(counts?.added)} />
        <Tile label="Updated" value={dash(counts?.updated)} />
        <Tile label="Unchanged" value={dash(counts?.unchanged)} />
        <Tile
          label="Failed"
          value={dash(counts?.failed)}
          hint={totals.failedOutstanding > 0 ? `${totals.failedOutstanding} need retry` : undefined}
        />
        <Tile
          label="Deleted"
          value={dash(counts?.deleted)}
          hint={totals.deleted > 0 ? `${totals.deleted} kept locally` : undefined}
        />
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">
        Last successful sync: {formatTime(status.lastSuccessAt)}
      </p>
    </div>
  );
}

export function SyncProgress({ status }: { status: SyncStatus }) {
  const { current } = status;
  if (!current) return null;
  const { progress } = current;
  return (
    <div className="mt-3">
      <div className="mb-1 flex justify-between gap-3 text-xs text-muted-foreground">
        <span className="truncate">
          {status.state === "paused" ? "Paused" : progress.currentUrl ?? "Starting…"}
        </span>
        <span className="shrink-0 tabular-nums">
          {progress.processed}/{progress.total} pages ({progress.percent}%)
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Synchronization progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        className="h-1.5 overflow-hidden rounded-full bg-secondary"
      >
        <div className="h-full bg-primary transition-[width]" style={{ width: `${progress.percent}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        The total grows while new pages are discovered.
      </p>
    </div>
  );
}
