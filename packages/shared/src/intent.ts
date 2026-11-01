import { validateNavigationUrl } from './url-policy.js';

/** Well-known sites, with how to search them where the address is stable. */
const SITES: Record<string, { url: string; search?: string }> = {
  youtube: {
    url: 'https://www.youtube.com/',
    search: 'https://www.youtube.com/results?search_query=',
  },
  wikipedia: {
    url: 'https://www.wikipedia.org/',
    search: 'https://en.wikipedia.org/w/index.php?search=',
  },
  github: { url: 'https://github.com/', search: 'https://github.com/search?q=' },
  google: { url: 'https://www.google.com/', search: 'https://www.google.com/search?q=' },
  gmail: { url: 'https://mail.google.com/' },
  reddit: { url: 'https://www.reddit.com/', search: 'https://www.reddit.com/search/?q=' },
  'stack overflow': {
    url: 'https://stackoverflow.com/',
    search: 'https://stackoverflow.com/search?q=',
  },
  mdn: {
    url: 'https://developer.mozilla.org/',
    search: 'https://developer.mozilla.org/en-US/search?q=',
  },
  amazon: { url: 'https://www.amazon.com/', search: 'https://www.amazon.com/s?k=' },
  linkedin: { url: 'https://www.linkedin.com/' },
  facebook: { url: 'https://www.facebook.com/' },
  instagram: { url: 'https://www.instagram.com/' },
  netflix: { url: 'https://www.netflix.com/' },
  spotify: { url: 'https://open.spotify.com/' },
};

/** Speech recognition splits these names, and people type them either way. */
const SITE_ALIASES: Record<string, string> = {
  'you tube': 'youtube',
  yt: 'youtube',
  'wiki pedia': 'wikipedia',
  'git hub': 'github',
  'g mail': 'gmail',
  stackoverflow: 'stack overflow',
};

export type SimpleStep =
  | { kind: 'new_tab' }
  /** `site` is set for a known site, so a following search can reuse the same page load. */
  | { kind: 'open'; url: string; newTab: boolean; site?: string }
  | { kind: 'search'; site: string | null; query: string }
  | { kind: 'switch_named'; name: string }
  | { kind: 'switch_position'; position: number }
  | { kind: 'switch_previous' }
  | { kind: 'scroll_direction'; direction: 'up' | 'down' | 'top' | 'bottom' }
  | { kind: 'scroll_text'; text: string }
  | { kind: 'reload' }
  | { kind: 'back' }
  | { kind: 'forward' }
  | { kind: 'close' };

const MAX_STEPS = 5;

function siteKey(raw: string): string | null {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/\s+(?:website|site|page|homepage)$/, '');
  const key = SITE_ALIASES[name] ?? name;
  return SITES[key] ? key : null;
}

function resolveTarget(raw: string): { url: string; site?: string } | null {
  const key = siteKey(raw);
  if (key) return { url: (SITES[key] as { url: string }).url, site: key };
  // Only something that is plainly an address. Anything else is a question for the AI.
  if (!/^(?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#]\S*)?$/i.test(raw))
    return null;
  const validated = validateNavigationUrl(raw);
  return validated.ok ? { url: validated.url } : null;
}

function parseClause(clause: string): SimpleStep | null {
  if (/^(?:open|create|start|make)(?: up)?(?: a)?(?: new)? tab$/i.test(clause)) {
    return /new|open|create/i.test(clause) ? { kind: 'new_tab' } : null;
  }

  if (/^(?:reload|refresh)(?: (?:the|this))?(?: (?:page|tab))?$/i.test(clause))
    return { kind: 'reload' };
  if (/^(?:go )?back$/i.test(clause)) return { kind: 'back' };
  if (/^(?:go )?forward$/i.test(clause)) return { kind: 'forward' };
  if (/^close(?: (?:this|the|the current|current))? tab$/i.test(clause)) return { kind: 'close' };

  if (
    /^(?:switch|go|return|get|change)(?: back)?(?: to)?(?: the| my)? (?:previous|last|other) tab$/i.test(
      clause,
    ) ||
    /^(?:switch|go|return) back$/i.test(clause)
  ) {
    return { kind: 'switch_previous' };
  }

  const position = /^(?:switch|go)(?: back)? to tab (\d{1,3})$/i.exec(clause);
  if (position?.[1]) return { kind: 'switch_position', position: Number(position[1]) };

  const switched =
    /^(?:switch|change|return|go back)(?: back)? to (?:the |my )?(.+?)(?: tab)?$/i.exec(clause);
  if (switched?.[1]) return { kind: 'switch_named', name: switched[1] };
  const toTab = /^go to (?:the |my )?((?:(?! in ).)+?) tab$/i.exec(clause);
  if (toTab?.[1]) return { kind: 'switch_named', name: toTab[1] };

  const direction =
    /^scroll(?: the page)?(?: (?:to the|to|all the way to the))? (up|down|top|bottom)$/i.exec(
      clause,
    );
  if (direction?.[1]) {
    return {
      kind: 'scroll_direction',
      direction: direction[1] as 'up' | 'down' | 'top' | 'bottom',
    };
  }
  const scrollTo = /^scroll(?: down)? to (?:the )?(.+?)(?: section| heading| part)?$/i.exec(clause);
  if (scrollTo?.[1]) return { kind: 'scroll_text', text: scrollTo[1] };

  const onSite = /^search (?:for )?(.+?) (?:on|in|using) (.+)$/i.exec(clause);
  if (onSite?.[1] && onSite[2]) {
    const site = siteKey(onSite[2]);
    return site ? { kind: 'search', site, query: onSite[1] } : null;
  }
  const siteFirst = /^search (.+?) for (.+)$/i.exec(clause);
  if (siteFirst?.[1] && siteFirst[2]) {
    const site = siteKey(siteFirst[1]);
    return site ? { kind: 'search', site, query: siteFirst[2] } : null;
  }
  const plainSearch = /^search for (.+)$/i.exec(clause);
  if (plainSearch?.[1]) return { kind: 'search', site: null, query: plainSearch[1] };

  const opened =
    /^(open|launch|go to|goto|navigate to|visit|take me to|head to|load|bring up|pull up)(?: up)? (.+?)(?: (in (?:a )?new tab|in (?:this|the current|the same) tab|here))?$/i.exec(
      clause,
    );
  if (opened?.[1] && opened[2]) {
    const target = resolveTarget(opened[2]);
    if (!target) return null;
    const asOpen = /^(open|launch)$/i.test(opened[1]);
    const where = opened[3] ?? '';
    return {
      kind: 'open',
      url: target.url,
      newTab: /new tab/i.test(where) || (asOpen && !where),
      ...(target.site && { site: target.site }),
    };
  }
  return null;
}

/**
 * Recognizes instructions simple enough to carry out without the AI, which makes them
 * instant and free. Every clause must be understood exactly, or the whole instruction
 * goes to the AI: this never guesses, and what it returns still passes every safety check.
 */
export function parseSimpleInstruction(input: string): SimpleStep[] | null {
  // Capitals stay, because web addresses and search terms can depend on them.
  const text = input
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .replace(/^(?:hey |ok |okay )?(?:do ?pilot[, ]+)?/i, '')
    .replace(/^(?:please |can you |could you |would you |i want you to )+/i, '')
    .replace(/ please$/i, '');
  if (!text || text.length > 200) return null;

  const clauses = text
    .split(/\s*[,;]\s*(?:and\s+)?(?:then\s+)?|\s+and\s+then\s+|\s+then\s+|\s+and\s+/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (clauses.length === 0 || clauses.length > MAX_STEPS) return null;

  const steps: SimpleStep[] = [];
  for (const clause of clauses) {
    const step = parseClause(clause);
    if (!step) return null;
    steps.push(step);
  }
  return steps;
}

/** The search address for a site, or null if it has no stable one. */
export function siteSearchUrl(site: string, query: string): string | null {
  const base = SITES[site]?.search;
  return base ? `${base}${encodeURIComponent(query)}` : null;
}
