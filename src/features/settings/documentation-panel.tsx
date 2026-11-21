"use client";

import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { DocsSourceView } from "@/lib/docs-source";
import { BACKEND_UNAVAILABLE } from "@/lib/hosting";
import { BackendUnreachableError, SyncApiError, syncClient } from "@/services/sync-client";

type Notice = { tone: "ok" | "error"; text: string } | null;

const toneClass = (tone: "ok" | "error") => (tone === "error" ? "text-sm text-destructive" : "text-sm text-emerald-600 dark:text-emerald-400");

/** Documentation source, main website and the list of domains the scraper is allowed to visit. */
export function DocumentationPanel() {
  const [view, setView] = useState<DocsSourceView | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [source, setSource] = useState("");
  const [website, setWebsite] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  /** Set when the backend asks to confirm a source change: how many indexed documents it affects. */
  const [confirmChange, setConfirmChange] = useState<number | null>(null);
  const [domain, setDomain] = useState("");
  const [confirmDomain, setConfirmDomain] = useState<string | null>(null);
  const [domainNotice, setDomainNotice] = useState<Notice>(null);
  const mounted = useRef(true);

  const apply = useCallback((next: DocsSourceView) => {
    setView(next);
    setSource(next.settings.sourceUrl);
    setWebsite(next.settings.websiteUrl);
  }, []);

  const [loadCode, setLoadCode] = useState<string | null>(null);
  const reload = useCallback(() => {
    setNotice(null);
    setUnreachable(false);
    setLoadCode(null);
    syncClient.getDocsSource().then(
      (next) => mounted.current && apply(next),
      (error: unknown) => {
        if (!mounted.current) return;
        if (error instanceof BackendUnreachableError) setUnreachable(true);
        else {
          setLoadCode(error instanceof SyncApiError ? error.code : null);
          setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not load the settings." });
        }
      },
    );
  }, [apply]);

  useEffect(() => {
    mounted.current = true;
    reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  async function save(confirmed = false, patch = { sourceUrl: source, websiteUrl: website }) {
    setBusy(true);
    setNotice(null);
    try {
      apply(await syncClient.saveDocsSource({ ...patch, ...(confirmed ? { confirmChange: true } : {}) }));
      setConfirmChange(null);
      setNotice({ tone: "ok", text: "Documentation settings saved." });
    } catch (error) {
      if (error instanceof SyncApiError && error.code === "confirmation_required") setConfirmChange(Number(error.data.documents ?? 0));
      else setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not save." });
    } finally {
      setBusy(false);
    }
  }

  async function domainAction(action: () => Promise<DocsSourceView>, success: string) {
    setBusy(true);
    setDomainNotice(null);
    try {
      apply(await action());
      setDomain("");
      setConfirmDomain(null);
      setDomainNotice({ tone: "ok", text: success });
    } catch (error) {
      setConfirmDomain(null);
      setDomainNotice({ tone: "error", text: error instanceof Error ? error.message : "That did not work." });
    } finally {
      setBusy(false);
    }
  }

  if (unreachable) return <Card><CardContent className="p-5 text-sm text-muted-foreground">Can&apos;t reach the local backend. Make sure the app is running and reload this page.</CardContent></Card>;
  if (!view && notice) {
    return (
      <Card>
        <CardContent className="space-y-3 p-5" data-testid="docs-source-error">
          <p className="text-sm font-medium">{loadCode === BACKEND_UNAVAILABLE ? "No local backend on this host" : "Couldn't load the documentation settings"}</p>
          <p role="alert" className="text-sm text-muted-foreground">{notice.text}</p>
          {loadCode === BACKEND_UNAVAILABLE ? null : (
            <Button variant="outline" size="sm" onClick={reload}>
              Try again
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }
  if (!view) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const dirty = source !== view.settings.sourceUrl || website !== view.settings.websiteUrl;
  const isDefault = view.settings.sourceUrl === view.defaults.sourceUrl && view.settings.websiteUrl === view.defaults.websiteUrl;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 p-5">
          <div>
            <p className="text-sm font-medium">Documentation source</p>
            <p className="text-sm text-muted-foreground">
              The scraper starts here and indexes only pages on this same site, below this path. It reads the documentation to answer your questions; it never sends your chats or keys anywhere.
            </p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="doc-source-url" className="text-sm font-medium">Documentation source URL</label>
            <Input id="doc-source-url" value={source} onChange={(e) => setSource(e.target.value)} spellCheck={false} autoComplete="off" disabled={busy || view.busy} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="doc-website-url" className="text-sm font-medium">Main website URL</label>
            <Input id="doc-website-url" value={website} onChange={(e) => setWebsite(e.target.value)} spellCheck={false} autoComplete="off" disabled={busy} />
            <p className="text-xs text-muted-foreground">Used for the link below only. It is never crawled.</p>
          </div>
          {view.busy ? <p role="status" className="text-sm text-amber-600 dark:text-amber-400">A synchronization is running, so the documentation source is locked until it ends.</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy || !dirty} onClick={() => void save()}>Save</Button>
            <Button size="sm" variant="outline" disabled={busy || isDefault || view.busy} onClick={() => { setSource(view.defaults.sourceUrl); setWebsite(view.defaults.websiteUrl); }}>Restore defaults</Button>
            <a href={view.settings.websiteUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary underline underline-offset-2">
              Open main website <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          </div>
          {confirmChange !== null ? (
            <div role="alertdialog" aria-label="Confirm source change" className="space-y-2 rounded-md border border-amber-500/50 p-3 text-sm">
              <p>
                {confirmChange} document(s) from the current source are indexed. Changing the source <strong>keeps</strong> them, but they will no longer be updated, and the next synchronization indexes the new source next to them.
              </p>
              <div className="flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => void save(true)}>Yes, change the source</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmChange(null)}>Cancel</Button>
              </div>
            </div>
          ) : null}
          {notice ? <p role={notice.tone === "error" ? "alert" : "status"} className={toneClass(notice.tone)}>{notice.text}</p> : null}
          <p className="text-xs text-muted-foreground" data-testid="doc-counts">{view.documents} document(s) in the local index.</p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 p-5">
          <div>
            <p className="text-sm font-medium">Allowed domains</p>
            <p className="text-sm text-muted-foreground">
              Custom scraping addresses are accepted only on approved domains. To use any other site you must add it here yourself; this list is stored on this computer only and is not part of backups.
            </p>
          </div>
          <ul className="flex flex-wrap gap-2" aria-label="Approved domains" data-testid="approved-domains">
            {view.approvedDomains.map((d) => (
              <li key={d} className="rounded-md border border-border px-2 py-1 text-xs"><span className="font-mono">{d}</span> <span className="text-muted-foreground">(approved, includes subdomains)</span></li>
            ))}
          </ul>
          <div>
            <p className="text-sm font-medium">Additional allowed domains</p>
            {view.settings.extraDomains.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="no-extra-domains">None. Only the approved domains above can be scraped.</p>
            ) : (
              <ul className="mt-2 space-y-1" aria-label="Additional allowed domains" data-testid="extra-domains">
                {view.settings.extraDomains.map((d) => (
                  <li key={d} className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1 text-sm">
                    <span className="font-mono">{d}</span>
                    <Button size="sm" variant="ghost" disabled={busy} aria-label={`Remove ${d}`} onClick={() => void domainAction(() => syncClient.removeDomain(d), `${d} removed.`)}>Remove</Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[14rem] flex-1 space-y-1.5">
              <label htmlFor="extra-domain" className="text-sm font-medium">Allow another domain</label>
              <Input id="extra-domain" value={domain} placeholder="docs.example.com" onChange={(e) => setDomain(e.target.value)} spellCheck={false} autoComplete="off" disabled={busy} />
            </div>
            <Button size="sm" variant="outline" disabled={busy || domain.trim() === ""} onClick={() => setConfirmDomain(domain.trim())}>Add domain…</Button>
          </div>
          {confirmDomain !== null ? (
            <div role="alertdialog" aria-label="Confirm new domain" className="space-y-2 rounded-md border border-amber-500/50 p-3 text-sm">
              <p>Allow the scraper to download pages from <span className="font-mono">{confirmDomain}</span>? Only do this for a site you trust.</p>
              <div className="flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => void domainAction(() => syncClient.addDomain(confirmDomain), `${confirmDomain} is now allowed.`)}>Yes, allow it</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDomain(null)}>Cancel</Button>
              </div>
            </div>
          ) : null}
          {domainNotice ? <p role={domainNotice.tone === "error" ? "alert" : "status"} className={toneClass(domainNotice.tone)}>{domainNotice.text}</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}
