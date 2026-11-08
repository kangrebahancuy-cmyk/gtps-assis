import type { ScraperConfig } from "@/server/scraper/config";

const TRACKING_PARAM = /^(utm_|fbclid$|gclid$)/i;
const NON_HTML_EXTENSION =
  /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|xml|txt|pdf|zip|gz|mp4|webm|woff2?|ttf|map)$/i;

/**
 * Canonical form used for duplicate detection: no hash, no tracking params,
 * sorted query, lower-case host, and no trailing slash (except the root).
 * Returns null for values that are not valid http(s) URLs.
 */
export function normalizeUrl(input: string, base?: string): string | null {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  url.hash = "";
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAM.test(key))
    .sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [key, value] of params) url.searchParams.append(key, value);

  let pathname = url.pathname.replace(/\/{2,}/g, "/");
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");
  url.pathname = pathname;

  return url.toString();
}

/** True for URLs the crawler is allowed to treat as documentation pages. */
export function isDocumentationUrl(
  url: string,
  config: Pick<ScraperConfig, "origin" | "pathPrefix">,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.origin !== config.origin) return false;
  if (NON_HTML_EXTENSION.test(parsed.pathname)) return false;
  const prefix = config.pathPrefix;
  return (
    prefix === "/" ||
    parsed.pathname === prefix ||
    parsed.pathname.startsWith(`${prefix}/`)
  );
}

/** Resolves and normalizes a link, returning it only if it is a doc page. */
export function resolveDocLink(
  href: string,
  pageUrl: string,
  config: Pick<ScraperConfig, "origin" | "pathPrefix">,
): string | null {
  const trimmed = href.trim();
  if (
    trimmed === "" ||
    trimmed.startsWith("#") ||
    /^(mailto|tel|javascript):/i.test(trimmed)
  ) {
    return null;
  }
  const normalized = normalizeUrl(trimmed, pageUrl);
  if (!normalized || !isDocumentationUrl(normalized, config)) return null;
  return normalized;
}
