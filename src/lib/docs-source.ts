/**
 * Which documentation sources the scraper may be pointed at.
 *
 * Shared by the backend (which enforces it) and the settings page (which only
 * explains it): the server never trusts the client's own check.
 *
 * Rule: a URL is accepted when its host is an approved domain (or a subdomain of
 * one). Any other host is refused unless the local user has explicitly added it
 * to the list of extra domains ("I trust this site"). Extra domains are stored
 * only on this computer and are not part of backups.
 */

export const APPROVED_DOMAINS: readonly string[] = ["gtps.cloud"];
export const DEFAULT_SOURCE_URL = "https://dash.gtps.cloud/docs";
export const DEFAULT_WEBSITE_URL = "https://gtps.cloud/";

export const MAX_EXTRA_DOMAINS = 20;

export interface DocsSourceSettings {
  /** Where the crawler starts. Only pages on this origin below this path are indexed. */
  sourceUrl: string;
  /** The project's main website, used for "open website" links. Never crawled. */
  websiteUrl: string;
  /** Hosts the local user explicitly allowed in addition to APPROVED_DOMAINS. */
  extraDomains: string[];
}

export type SourceUrlProblem = "invalid_url" | "unsupported_scheme" | "credentials" | "domain_not_approved";

export type SourceUrlCheck = { ok: true; url: string; host: string } | { ok: false; problem: SourceUrlProblem; message: string; host?: string };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export const isLoopbackHost = (host: string): boolean => LOOPBACK.has(host);

/** True when `host` is `domain` or one of its subdomains (never a lookalike such as "evilgtps.cloud"). */
export function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

export function isDomainApproved(host: string, extraDomains: readonly string[] = []): boolean {
  return [...APPROVED_DOMAINS, ...extraDomains].some((domain) => hostMatches(host, domain));
}

/**
 * Cleans what the user typed into a bare host name (no scheme, path, port or wildcard).
 * Returns null when it is not a usable host. Top-level names alone ("com") are refused so one entry cannot approve a whole TLD.
 */
export function normalizeDomain(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (value === "") return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(value)) {
    try {
      value = new URL(value).hostname;
    } catch {
      return null;
    }
  }
  value = value.replace(/\/.*$/, "").replace(/:\d+$/, "");
  if (value.includes("*") || value.includes("@") || value.includes(" ")) return null;
  if (value === "::1" || value === "[::1]") return "[::1]";
  const ip = IPV4.exec(value);
  if (ip) return ip.slice(1).every((part) => Number(part) <= 255) ? value : null;
  if (value === "localhost") return value;
  if (!HOSTNAME.test(value) || !value.includes(".")) return null;
  return value;
}

/** Validates a documentation or website URL against the approved and extra domains. */
export function checkSourceUrl(input: unknown, extraDomains: readonly string[] = []): SourceUrlCheck {
  if (typeof input !== "string" || input.trim() === "" || input.length > 2048) {
    return { ok: false, problem: "invalid_url", message: "Enter a full web address such as https://dash.gtps.cloud/docs." };
  }
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, problem: "invalid_url", message: "That is not a valid web address. Include https:// at the start." };
  }
  const host = url.hostname.toLowerCase();
  const isLoopback = isLoopbackHost(host);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    return { ok: false, problem: "unsupported_scheme", message: "Only https:// addresses are accepted (http:// is allowed only for this computer, localhost)." };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, problem: "credentials", message: "Addresses with a user name or password are not accepted." };
  }
  if (!isDomainApproved(host, extraDomains)) {
    return {
      ok: false,
      problem: "domain_not_approved",
      host,
      message: `${host} is not an approved documentation domain. Approved: ${APPROVED_DOMAINS.join(", ")}. To use another site, first add it under "Additional allowed domains".`,
    };
  }
  url.hash = "";
  return { ok: true, url: url.toString(), host };
}

/** What GET /api/docs-source returns. */
export interface DocsSourceView {
  settings: DocsSourceSettings;
  approvedDomains: string[];
  defaults: { sourceUrl: string; websiteUrl: string };
  /** Documents in the local index (excluding deleted ones). */
  documents: number;
  /** A synchronization is open, so the source cannot be changed right now. */
  busy: boolean;
}

/** True for private-network and link-local address literals (10.x, 172.16-31.x, 192.168.x, 169.254.x, fc00::/7, fe80::/10). */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return h === "::1" || h === "::" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || h.startsWith("::ffff:");
}
