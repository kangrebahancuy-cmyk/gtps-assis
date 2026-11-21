import {
  DEFAULT_SOURCE_URL,
  DEFAULT_WEBSITE_URL,
  MAX_EXTRA_DOMAINS,
  checkSourceUrl,
  isDomainApproved,
  normalizeDomain,
  type DocsSourceSettings,
} from "@/lib/docs-source";

/** Anything with the two metadata calls of Repository (SQLite sync_metadata). */
export interface MetaStore {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

export class DocsSourceError extends Error {
  constructor(
    message: string,
    readonly code: "invalid" | "domain_not_approved" | "limit" | "in_use" = "invalid",
  ) {
    super(message);
  }
}

const KEY = { source: "docs_source.url", website: "docs_source.website", domains: "docs_source.extra_domains" } as const;

/**
 * Documentation source settings, stored in the local SQLite database next to the
 * index they describe. Every value read back is re-validated, so a hand-edited
 * database cannot smuggle in an unapproved host.
 */
export class DocsSourceStore {
  constructor(private readonly meta: MetaStore) {}

  private domains(): string[] {
    try {
      const raw: unknown = JSON.parse(this.meta.getMeta(KEY.domains) || "[]");
      if (!Array.isArray(raw)) return [];
      return raw.filter((d): d is string => typeof d === "string").map((d) => normalizeDomain(d)).filter((d): d is string => d !== null).slice(0, MAX_EXTRA_DOMAINS);
    } catch {
      return [];
    }
  }

  get(): DocsSourceSettings {
    const extraDomains = this.domains();
    const source = checkSourceUrl(this.meta.getMeta(KEY.source) ?? DEFAULT_SOURCE_URL, extraDomains);
    const website = checkSourceUrl(this.meta.getMeta(KEY.website) ?? DEFAULT_WEBSITE_URL, extraDomains);
    return {
      sourceUrl: source.ok ? source.url : DEFAULT_SOURCE_URL,
      websiteUrl: website.ok ? website.url : DEFAULT_WEBSITE_URL,
      extraDomains,
    };
  }

  /** Validates and saves. Nothing is written when any field is refused. */
  update(patch: { sourceUrl?: unknown; websiteUrl?: unknown }): DocsSourceSettings {
    const current = this.get();
    const next = { ...current };
    for (const [field, label] of [["sourceUrl", "Documentation source URL"], ["websiteUrl", "Main website URL"]] as const) {
      const value = patch[field];
      if (value === undefined) continue;
      const check = checkSourceUrl(value, current.extraDomains);
      if (!check.ok) throw new DocsSourceError(`${label}: ${check.message}`, check.problem === "domain_not_approved" ? "domain_not_approved" : "invalid");
      next[field] = check.url;
    }
    this.meta.setMeta(KEY.source, next.sourceUrl);
    this.meta.setMeta(KEY.website, next.websiteUrl);
    return next;
  }

  addDomain(input: unknown): DocsSourceSettings {
    const domain = typeof input === "string" ? normalizeDomain(input) : null;
    if (domain === null) throw new DocsSourceError("Enter a host name such as docs.example.com (no https://, path or wildcard).");
    const current = this.get();
    if (isDomainApproved(domain, current.extraDomains)) return current;
    if (current.extraDomains.length >= MAX_EXTRA_DOMAINS) throw new DocsSourceError(`At most ${MAX_EXTRA_DOMAINS} additional domains are allowed.`, "limit");
    const extraDomains = [...current.extraDomains, domain];
    this.meta.setMeta(KEY.domains, JSON.stringify(extraDomains));
    return { ...current, extraDomains };
  }

  /** Removing a domain that the current source or website still uses is refused (they would become invalid). */
  removeDomain(input: unknown): DocsSourceSettings {
    const domain = typeof input === "string" ? normalizeDomain(input) : null;
    if (domain === null) throw new DocsSourceError("Enter the host name to remove.");
    const current = this.get();
    const extraDomains = current.extraDomains.filter((d) => d !== domain);
    for (const [url, label] of [[current.sourceUrl, "documentation source"], [current.websiteUrl, "main website"]] as const) {
      if (!checkSourceUrl(url, extraDomains).ok) throw new DocsSourceError(`${domain} is used by the ${label} URL. Change that URL first.`, "in_use");
    }
    this.meta.setMeta(KEY.domains, JSON.stringify(extraDomains));
    return { ...current, extraDomains };
  }
}
