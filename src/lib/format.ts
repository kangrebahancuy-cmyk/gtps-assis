/** Date formatting for the UI. Returns a label for missing or unparsable input instead of throwing. */
export function formatDateTime(iso: string | null | undefined, missing = "Never"): string {
  if (!iso) return missing;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}
