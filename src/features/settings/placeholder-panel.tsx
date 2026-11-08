import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

export interface PlaceholderRow {
  label: string;
  description: string;
  /** Shows a disabled toggle instead of a status text. */
  toggle?: boolean;
  status?: string;
}

interface PlaceholderPanelProps {
  rows: readonly PlaceholderRow[];
}

/** Settings rows that are not wired up yet. Everything here is disabled. */
export function PlaceholderPanel({ rows }: PlaceholderPanelProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          Not available yet
          <Badge variant="muted">Placeholder</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li
              key={row.label}
              className="flex items-center justify-between gap-4 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{row.label}</p>
                <p className="text-sm text-muted-foreground">{row.description}</p>
              </div>
              {row.toggle ? (
                <Switch disabled aria-label={row.label} />
              ) : (
                <span className="shrink-0 text-sm text-muted-foreground">
                  {row.status ?? "Not configured"}
                </span>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
