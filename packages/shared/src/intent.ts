import { PRESSABLE_KEYS } from './content-protocol.js';
import type { PressableKey } from './content-protocol.js';
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
  | { kind: 'new_tabs'; count: number }
  | { kind: 'open_many'; urls: string[] }
  /** Sends each tab from the batch just before it to this address. */
  | { kind: 'open_each'; url: string }
  /** A position in the batch just before it. */
  | { kind: 'switch_created'; which: number | 'last' }
  /** `site` is set for a known site, so a following search can reuse the same page load. */
  | { kind: 'open'; url: string; newTab: boolean; site?: string }
  | { kind: 'search'; site: string | null; query: string }
  | { kind: 'switch_named'; name: string }
  | { kind: 'switch_position'; position: number }
  | { kind: 'switch_previous' }
  | { kind: 'scroll_direction'; direction: 'up' | 'down' | 'top' | 'bottom' }
  | { kind: 'scroll_text'; text: string }
  | { kind: 'press'; key: PressableKey }
  | { kind: 'reload' }
  | { kind: 'back' }
  | { kind: 'forward' }
  | { kind: 'close' };

const MAX_STEPS = 5;
/** "Scroll down 5 times" is one clause but several steps. Past this it needs a person's eye. */
const MAX_REPEATS = 10;
const MAX_TOTAL_STEPS = 15;
/** Room for a list of addresses. Anything longer is not a simple instruction. */
const MAX_PARSED_CHARS = 1000;

const UNITS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ORDINALS = [
  '',
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
  'eleventh',
  'twelfth',
  'thirteenth',
  'fourteenth',
  'fifteenth',
  'sixteenth',
  'seventeenth',
  'eighteenth',
  'nineteenth',
  'twentieth',
];

/** "10", "ten", "twenty-five", "a dozen", "a hundred". Null for anything less certain. */
export function parseCount(raw: string): number | null {
  const text = raw.trim().toLowerCase().replace(/-/g, ' ');
  if (/^\d{1,9}$/.test(text)) return Number(text);
  if (text === 'a couple' || text === 'a couple of' || text === 'couple of') return 2;
  if (text === 'a dozen' || text === 'dozen') return 12;
  const big = /^(?:a|an|one) (hundred|thousand|million)$/.exec(text)?.[1];
  if (big) return { hundred: 100, thousand: 1000, million: 1_000_000 }[big] ?? null;
  const unit = UNITS.indexOf(text);
  if (unit !== -1) return unit;
  const [tens = '', ones, extra] = text.split(' ');
  const tensIndex = TENS.indexOf(tens);
  if (tensIndex < 2 || extra !== undefined) return null;
  if (ones === undefined) return tensIndex * 10;
  const onesIndex = UNITS.indexOf(ones);
  return onesIndex >= 1 && onesIndex <= 9 ? tensIndex * 10 + onesIndex : null;
}

function parsePosition(raw: string): number | 'last' | null {
  const text = raw.trim().toLowerCase();
  if (text === 'last' || text === 'final') return 'last';
  const numeric = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(text)?.[1];
  if (numeric) return Number(numeric) || null;
  const ordinal = ORDINALS.indexOf(text);
  return ordinal > 0 ? ordinal : null;
}

/** "YouTube, GitHub, and Wikipedia" as addresses, or null unless every one is certain. */
function parseTargetList(raw: string): string[] | null {
  const names = raw
    .split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)
    .map((name) => name.trim())
    .filter(Boolean);
  const urls: string[] = [];
  for (const name of names) {
    const target = resolveTarget(name);
    if (!target) return null;
    urls.push(target.url);
  }
  return urls.length > 0 ? urls : null;
}

/** Instructions that are one batch as a whole, so their commas do not separate steps. */
function parseWholeBatch(text: string): SimpleStep | null {
  const separate =
    /^(?:open|launch|load|create)\s+(.+?)\s+(?:each\s+)?in\s+(?:a\s+)?(?:separate|different|individual|their own|new)\s+tabs?$/i.exec(
      text,
    )?.[1] ?? /^(?:open|create|make)\s+(?:new\s+)?tabs\s+for\s+(.+)$/i.exec(text)?.[1];
  if (separate) {
    const urls = parseTargetList(separate);
    return urls ? { kind: 'open_many', urls } : null;
  }
  // "Open YouTube and GitHub": only when every name is certain, so nothing else is lost.
  const listed = /^(?:open|launch)\s+(.+(?:,|\s+and\s+).+)$/i.exec(text)?.[1];
  const urls = listed ? parseTargetList(listed) : null;
  return urls && urls.length > 1 ? { kind: 'open_many', urls } : null;
}

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

function parseBatchClause(clause: string): SimpleStep | null {
  const counted =
    /^(?:open|create|make|start|add)(?: up)? (.+?)(?: more)?(?: new| blank| empty| fresh)* tabs?$/i.exec(
      clause,
    )?.[1];
  if (counted) {
    const count = parseCount(counted);
    if (count === null) return null;
    return count === 1 ? { kind: 'new_tab' } : { kind: 'new_tabs', count };
  }

  const each =
    /^(?:navigate|point|send|go|load|open)(?: to)? (?:each|all|every one|each one|each of them|all of them|them all|them)(?: of them)?(?: to)? (.+)$/i.exec(
      clause,
    )?.[1] ??
    /^(?:navigate to|go to|load|open) (.+?) in (?:each|all|every)(?: one| of them| tab)?$/i.exec(
      clause,
    )?.[1];
  if (each) {
    const target = resolveTarget(each);
    return target ? { kind: 'open_each', url: target.url } : null;
  }

  const created =
    /^(?:switch|go|move|jump)(?: back)? to (?:the )?(\w+)(?: one| tab| new tab| new one)?$/i.exec(
      clause,
    )?.[1];
  if (created) {
    const which = parsePosition(created);
    if (which !== null) return { kind: 'switch_created', which };
  }
  return null;
}

const isBatch = (step: SimpleStep | undefined) =>
  step?.kind === 'new_tabs' || step?.kind === 'open_many';

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
  const ordinal = /^(?:switch|go)(?: back)? to (?:the )?(\w+) tab$/i.exec(clause)?.[1];
  const place = ordinal ? ORDINALS.indexOf(ordinal.toLowerCase()) : -1;
  if (place > 0) return { kind: 'switch_position', position: place };

  const pressed = /^(?:press|hit) (?:the )?(.+?)(?: key)?$/i.exec(clause)?.[1];
  if (pressed) {
    const wanted = pressed.toLowerCase().replace(/[\s-]+/g, '');
    const key = PRESSABLE_KEYS.find((name) => name.toLowerCase() === wanted);
    return key ? { kind: 'press', key } : null;
  }

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

const REPEATABLE = new Set<SimpleStep['kind']>([
  'scroll_direction',
  'press',
  'reload',
  'back',
  'forward',
]);

/** "Scroll down 5 times", "reload twice". */
function splitRepeat(raw: string): { clause: string; times: number } {
  const match = /^(.+?) (?:(once|twice|thrice)|(\S+) times)$/i.exec(raw);
  if (!match?.[1]) return { clause: raw, times: 1 };
  const word = match[2]?.toLowerCase();
  const times = word ? ({ once: 1, twice: 2, thrice: 3 }[word] ?? 1) : parseCount(match[3] ?? '');
  return times === null ? { clause: raw, times: 1 } : { clause: match[1], times };
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
  if (!text || text.length > MAX_PARSED_CHARS) return null;

  const whole = parseWholeBatch(text);
  if (whole) return [whole];

  const clauses = text
    .split(/\s*[,;]\s*(?:and\s+)?(?:then\s+)?|\s+and\s+then\s+|\s+then\s+|\s+and\s+/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (clauses.length === 0 || clauses.length > MAX_STEPS) return null;

  const steps: SimpleStep[] = [];
  for (const raw of clauses) {
    const { clause, times } = splitRepeat(raw);
    if (times < 1 || times > MAX_REPEATS) return null;
    // Batches read differently after one: "the last tab" means the last of those just opened.
    const batch = parseBatchClause(clause);
    const follows = isBatch(steps.at(-1));
    const needsBatch = batch?.kind === 'open_each' || batch?.kind === 'switch_created';
    const step = batch && (!needsBatch || follows) ? batch : parseClause(clause);
    if (!step) return null;
    // Only actions that mean something twice. Opening or switching twice is not a request.
    if (times > 1 && !REPEATABLE.has(step.kind)) return null;
    for (let count = 0; count < times; count += 1) steps.push(step);
  }
  return steps.length <= MAX_TOTAL_STEPS ? steps : null;
}

/** The search address for a site, or null if it has no stable one. */
export function siteSearchUrl(site: string, query: string): string | null {
  const base = SITES[site]?.search;
  return base ? `${base}${encodeURIComponent(query)}` : null;
}
