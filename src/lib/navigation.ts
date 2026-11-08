import type { NavItem } from "@/types";

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Whether a navigation item should be shown as active for a pathname. */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (item.excludePrefixes?.some((p) => matchesPrefix(pathname, p))) {
    return false;
  }
  // Settings links point at a section; match the whole /settings area.
  const base = item.href.startsWith("/settings") ? "/settings" : item.href;
  return matchesPrefix(pathname, base);
}
