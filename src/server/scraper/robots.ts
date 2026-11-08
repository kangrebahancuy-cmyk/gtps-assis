interface Rule {
  allow: boolean;
  pattern: string;
}

export interface RobotsPolicy {
  isAllowed: (url: string) => boolean;
  /** Crawl-delay for our agent in milliseconds, if the site sets one. */
  crawlDelayMs: number | null;
  sitemaps: string[];
}

export const ALLOW_ALL: RobotsPolicy = {
  isAllowed: () => true,
  crawlDelayMs: null,
  sitemaps: [],
};

export const DISALLOW_ALL: RobotsPolicy = {
  isAllowed: () => false,
  crawlDelayMs: null,
  sitemaps: [],
};

function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`);
}

/**
 * Parses robots.txt for one user agent. Uses the group that names our agent
 * token, else the "*" group. The longest matching rule wins; Allow wins ties.
 */
export function parseRobots(text: string, agentToken: string): RobotsPolicy {
  const token = agentToken.toLowerCase();
  const groups: { agents: string[]; rules: Rule[]; delay: number | null }[] = [];
  const sitemaps: string[] = [];

  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], delay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;

    if (field === "allow" || field === "disallow") {
      // An empty Disallow means "allow everything" and adds no rule.
      if (value) current.rules.push({ allow: field === "allow", pattern: value });
    } else if (field === "crawl-delay") {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
        current.delay = seconds * 1000;
      }
    }
  }

  const specific = groups.filter((g) =>
    g.agents.some((a) => a !== "*" && token.includes(a)),
  );
  const chosen = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes("*"));

  const rules = chosen.flatMap((g) => g.rules);
  const delays = chosen.map((g) => g.delay).filter((d): d is number => d !== null);
  const compiled = rules.map((rule) => ({
    allow: rule.allow,
    length: rule.pattern.length,
    regex: patternToRegExp(rule.pattern),
  }));

  return {
    sitemaps,
    crawlDelayMs: delays.length > 0 ? Math.max(...delays) : null,
    isAllowed: (url) => {
      let target: string;
      try {
        const parsed = new URL(url);
        target = parsed.pathname + parsed.search;
      } catch {
        return false;
      }
      let best: { allow: boolean; length: number } | null = null;
      for (const rule of compiled) {
        if (!rule.regex.test(target)) continue;
        if (
          !best ||
          rule.length > best.length ||
          (rule.length === best.length && rule.allow)
        ) {
          best = { allow: rule.allow, length: rule.length };
        }
      }
      return best ? best.allow : true;
    },
  };
}
