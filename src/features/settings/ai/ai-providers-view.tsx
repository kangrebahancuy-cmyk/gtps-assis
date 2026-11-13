import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { errorHint, formatDuration } from "@/lib/ai-format";
import type { AiBusy, AiNotice } from "@/hooks/use-ai-settings";
import type { ConnectionTestResult, ProviderId, ProviderStatus, QuotaWindow } from "@/types/ai";

export interface AiProvidersViewProps {
  providers: readonly ProviderStatus[];
  keyDrafts: Record<ProviderId, string>;
  tests: Partial<Record<ProviderId, ConnectionTestResult>>;
  busy: AiBusy;
  notice: AiNotice | null;
  /** Current time in ms; passed in so the view stays pure. */
  now: number;
  onKeyChange(provider: ProviderId, value: string): void;
  onTest(provider: ProviderId, scope: "key" | "model"): void;
  onSave(): void;
  onRemove(provider: ProviderId): void;
  onRemoveAll(): void;
}

function quotaText(label: string, window: QuotaWindow | null): string | null {
  if (!window || (window.remaining === null && window.limit === null)) return null;
  const amount = window.limit === null ? `${window.remaining} remaining` : `${window.remaining ?? "?"} of ${window.limit} remaining`;
  return `${label}: ${amount}${window.resetsIn ? ` (resets in ${window.resetsIn})` : ""}`;
}

export function TestResult({ result }: { result: ConnectionTestResult }) {
  if (result.ok) {
    return (
      <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">
        {result.scope === "model"
          ? `Connected. ${result.testedModel} produced a reply.`
          : `Connected. ${result.modelCount ?? 0} models found.`}
        {result.latencyMs !== null ? ` (${result.latencyMs} ms)` : ""}
      </p>
    );
  }
  const hint = result.error ? errorHint(result.error) : null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {result.error?.message ?? "The test failed."}
      {hint ? ` ${hint}` : ""}
    </p>
  );
}

function ProviderCard({ status, props }: { status: ProviderStatus; props: AiProvidersViewProps }) {
  const { provider } = status;
  const draft = props.keyDrafts[provider];
  const test = props.tests[provider];
  const testing = props.busy === `test:${provider}`;
  const cooldownMs = status.cooldownUntil ? new Date(status.cooldownUntil).getTime() - props.now : 0;
  const quota = status.rateLimit
    ? [quotaText("Requests", status.rateLimit.requests), quotaText("Tokens", status.rateLimit.tokens)].filter((line): line is string => line !== null)
    : [];
  const inputId = `${provider}-api-key`;

  return (
    <Card aria-labelledby={`${provider}-title`}>
      <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
        <CardTitle id={`${provider}-title`}>{status.label}</CardTitle>
        {status.configured ? (
          <Badge>{status.keySource === "environment" ? `Key from environment ${status.keyHint ?? ""}` : `Key saved ${status.keyHint ?? ""}`}</Badge>
        ) : (
          <Badge variant="muted">Not configured</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <label htmlFor={inputId} className="text-sm font-medium">
            API key
          </label>
          <Input
            id={inputId}
            name={inputId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            placeholder={status.configured ? "Enter a new key to replace the current one" : "Paste your API key"}
            onChange={(event) => props.onKeyChange(provider, event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            The key is sent only to this app&apos;s local backend, which stores it on this computer and talks to {status.label} for you. It is never shown again.{" "}
            <a className="underline" href={status.docsUrl} target="_blank" rel="noreferrer">
              {status.label} documentation
            </a>
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={props.busy !== null || (!status.configured && draft.trim() === "")} onClick={() => props.onTest(provider, "key")}>
            {testing ? "Testing…" : draft.trim() ? "Test this key" : "Test connection"}
          </Button>
          <Button variant="outline" size="sm" disabled={props.busy !== null || !status.configured || draft.trim() !== ""} onClick={() => props.onTest(provider, "model")}>
            Test a reply
          </Button>
          {status.keySource === "saved" ? (
            <Button variant="ghost" size="sm" disabled={props.busy !== null} onClick={() => props.onRemove(provider)}>
              Remove saved key
            </Button>
          ) : null}
        </div>

        {test ? <TestResult result={test} /> : null}
        {status.keySource === "environment" ? (
          <p className="text-xs text-muted-foreground">This key comes from an environment variable, so it can&apos;t be removed here. A key saved here would take precedence over it.</p>
        ) : null}
        {cooldownMs > 0 ? (
          <p role="status" className="text-sm text-amber-600 dark:text-amber-400">
            Rate limit reached. Chat requests to {status.label} are paused for about {formatDuration(cooldownMs)}.
          </p>
        ) : null}

        <div className="space-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Quota</p>
          {quota.length > 0 ? (
            <>
              {quota.map((line) => (
                <p key={line}>{line}</p>
              ))}
              <p>Reported by {status.label} in its last response ({new Date(status.rateLimit!.observedAt).toLocaleTimeString()}); it is not a prediction.</p>
            </>
          ) : (
            <p>No quota reported yet.</p>
          )}
          <p>{status.quotaNote}</p>
          <p>
            Free-tier eligibility is not verified.{" "}
            <a className="underline" href={status.limitsUrl} target="_blank" rel="noreferrer">
              See {status.label} rate limits
            </a>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function AiProvidersView(props: AiProvidersViewProps) {
  const anySaved = props.providers.some((p) => p.keySource === "saved");
  const typed = Object.values(props.keyDrafts).some((v) => v.trim() !== "");
  return (
    <div className="space-y-4">
      {props.providers.map((status) => (
        <ProviderCard key={status.provider} status={status} props={props} />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={props.busy !== null || !typed} onClick={props.onSave}>
          {props.busy === "save-keys" ? "Saving…" : "Save configuration"}
        </Button>
        <Button variant="outline" disabled={props.busy !== null || !anySaved} onClick={props.onRemoveAll}>
          Remove all saved configuration
        </Button>
      </div>
      {props.notice ? (
        <p role={props.notice.tone === "error" ? "alert" : "status"} className={props.notice.tone === "error" ? "text-sm text-destructive" : "text-sm text-emerald-600 dark:text-emerald-400"}>
          {props.notice.text}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Saved keys are stored as plain text in <code>data/ai-config.json</code> on this computer (owner-only permissions, excluded from git). Anyone who can read your files can read them.
      </p>
    </div>
  );
}
