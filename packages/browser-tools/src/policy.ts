import type { DescribeResult, ElementFacts, PageFacts } from '@dopilot/shared';

export type ApprovalCategory =
  | 'form_submission'
  | 'purchase'
  | 'account_change'
  | 'send_message'
  | 'file_upload'
  | 'destructive'
  | 'data_in_address';

export type PolicyDecision =
  | { decision: 'allow' }
  | { decision: 'approve'; category: ApprovalCategory; reason: string }
  | { decision: 'block'; code: string; reason: string; stopTask?: boolean };

/** What the task has done so far, for decisions that depend on more than one call. */
export interface PolicyContext {
  instruction?: string;
  /** Webpage content has reached the model during this task. */
  pageDataRead?: boolean;
}

const ALLOW: PolicyDecision = { decision: 'allow' };

const RULES: [ApprovalCategory, RegExp, string][] = [
  [
    'purchase',
    /\b(buy|purchase|checkout|check ?out|place (your )?order|pay|pay now|order now|confirm order|subscribe|donate|add payment|start (free )?trial)\b/i,
    'This looks like it spends money.',
  ],
  [
    'send_message',
    /\b(send|post|publish|tweet|reply|comment|share|invite|email)\b/i,
    'This looks like it sends something to other people.',
  ],
  [
    'account_change',
    /\b(save changes|update (profile|account|settings|email|password)|change (password|email)|sign out|log ?out|deactivate|close account|unsubscribe|enable|disable|grant|authorize|allow access|accept terms|i agree)\b/i,
    'This looks like it changes your account.',
  ],
  [
    'destructive',
    /\b(delete|remove|discard|erase|destroy|clear all|reset|revoke|cancel (order|subscription|booking|plan)|uninstall)\b/i,
    'This looks like it deletes or undoes something.',
  ],
  [
    'file_upload',
    /\b(upload|attach|choose file|browse files)\b/i,
    'This looks like a file upload.',
  ],
];

// Addresses are checked too, because following a link does the same as clicking a button.
const SENSITIVE_PATH =
  /\/(log-?out|sign-?out|delete|remove|unsubscribe|checkout|purchase|pay|deactivate)(\/|$|\?|#)/i;

const ASSESSMENT_CONTEXT =
  /\b(quiz(zes)?|exams?|examination|assessments?|midterm|graded|test attempt|assignments?)\b/i;
const ASSESSMENT_SUBMIT =
  /\b(submit|finish|turn in|hand in|complete attempt|end (test|exam|attempt)|finish attempt)\b/i;

/** Long addresses can carry data read from a page out to another site. */
const MAX_UNREVIEWED_URL_LENGTH = 300;

function isAssessment(page: PageFacts): boolean {
  return ASSESSMENT_CONTEXT.test([page.title, page.url, ...page.headings].join(' '));
}

const CHALLENGE: PolicyDecision = {
  decision: 'block',
  code: 'security_challenge',
  reason: 'This page has a CAPTCHA or security check, which only you can complete.',
  stopTask: true,
};

function assessActivation(element: ElementFacts | null, page: PageFacts): PolicyDecision {
  if (page.hasChallenge || element?.isChallenge) return CHALLENGE;
  if (!element) return ALLOW;

  const label = `${element.name} ${element.href ?? ''}`;

  const submitsForm = element.isSubmit && element.inForm;
  if ((submitsForm || ASSESSMENT_SUBMIT.test(element.name)) && isAssessment(page)) {
    return {
      decision: 'block',
      code: 'assessment_submission',
      reason:
        'This looks like a graded quiz or assessment, so Dopilot will not submit it. Review it and submit it yourself.',
      stopTask: true,
    };
  }

  if (element.isFileInput) {
    return { decision: 'approve', category: 'file_upload', reason: 'This uploads a file.' };
  }

  for (const [category, pattern, reason] of RULES) {
    if (pattern.test(label)) return { decision: 'approve', category, reason };
  }
  if (element.href && SENSITIVE_PATH.test(element.href)) {
    return {
      decision: 'approve',
      category: 'destructive',
      reason: 'This link looks like it changes something.',
    };
  }

  if (submitsForm && !element.isSearchForm) {
    return { decision: 'approve', category: 'form_submission', reason: 'This submits a form.' };
  }
  return ALLOW;
}

function assessKey(key: unknown, facts: DescribeResult): PolicyDecision {
  const { element, page } = facts;
  if (page.hasChallenge) return CHALLENGE;
  if (key === 'Enter' && element?.isSearchForm) return ALLOW;

  if (key === 'Enter' && element?.inForm) {
    if (isAssessment(page)) {
      return {
        decision: 'block',
        code: 'assessment_submission',
        reason:
          'This looks like a graded quiz or assessment, so Dopilot will not submit it. Review it and submit it yourself.',
        stopTask: true,
      };
    }
    return { decision: 'approve', category: 'form_submission', reason: 'Enter submits this form.' };
  }
  // Enter and Space activate a focused control, so keys get the same rules as clicks.
  if ((key === 'Enter' || key === 'Space') && element) return assessActivation(element, page);
  return ALLOW;
}

/** Long enough to carry something worth stealing, and too long to be a chance match. */
const MIN_CARRIED_DATA_CHARS = 16;

function isPrivateHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host === '[::1]'
  );
}

function appearsIn(instruction: string, value: string): boolean {
  const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return normalize(instruction).includes(normalize(value));
}

/**
 * Once a task has read a webpage, an address the model builds might be what that page told
 * it to build, with the user's data in it or pointing at their router. Whatever came from
 * the user's own instruction is fine. Anything else is theirs to approve.
 */
function assessAfterReading(url: string, instruction: string): PolicyDecision {
  let parsed: URL;
  try {
    parsed = new URL(url.includes('://') ? url : `https://${url}`);
  } catch {
    return ALLOW;
  }
  const named = appearsIn(instruction, parsed.hostname.replace(/^www\./, ''));
  if (isPrivateHost(parsed.hostname) && !named) {
    return {
      decision: 'approve',
      category: 'data_in_address',
      reason: 'A page led here, and this address is on your own network.',
    };
  }
  const values = [
    ...parsed.searchParams.values(),
    ...parsed.pathname.split('/').map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    }),
  ];
  const unexplained = values.some(
    (value) => value.length >= MIN_CARRIED_DATA_CHARS && !appearsIn(instruction, value),
  );
  if (unexplained && !named) {
    return {
      decision: 'approve',
      category: 'data_in_address',
      reason: 'This address contains something you did not ask for, which could be page data.',
    };
  }
  return ALLOW;
}

function assessAddress(url: unknown, context?: PolicyContext): PolicyDecision {
  if (typeof url !== 'string') return ALLOW;
  if (url.length > MAX_UNREVIEWED_URL_LENGTH) {
    return {
      decision: 'approve',
      category: 'data_in_address',
      reason: 'This unusually long address could carry page data to another site.',
    };
  }
  if (SENSITIVE_PATH.test(url)) {
    return {
      decision: 'approve',
      category: 'destructive',
      reason: 'This address looks like it changes something.',
    };
  }
  if (context?.pageDataRead) return assessAfterReading(url, context.instruction ?? '');
  return ALLOW;
}

/**
 * The safety decision for one tool call. It only looks at facts collected from the
 * page by code, so neither the model nor page content can argue its way past it.
 * It runs for the agent and for MCP alike.
 */
export function assessToolCall(
  name: string,
  args: Record<string, unknown>,
  facts: DescribeResult | null,
  context?: PolicyContext,
): PolicyDecision {
  switch (name) {
    case 'open_tab':
    case 'navigate':
      return assessAddress(args.url, context);

    case 'close_tab':
      return { decision: 'approve', category: 'destructive', reason: 'This closes a tab.' };

    case 'click_element':
      return facts ? assessActivation(facts.element, facts.page) : ALLOW;

    case 'press_key':
      return facts ? assessKey(args.key, facts) : ALLOW;

    case 'type_text':
    case 'clear_input':
    case 'select_option': {
      if (!facts) return ALLOW;
      if (facts.page.hasChallenge || facts.element?.isChallenge) return CHALLENGE;
      if (facts.element?.isSecretField) {
        return {
          decision: 'block',
          code: 'secret_field',
          reason: 'Dopilot does not fill in passwords, card numbers or security codes.',
        };
      }
      if (facts.element?.isFileInput) {
        return { decision: 'approve', category: 'file_upload', reason: 'This uploads a file.' };
      }
      return ALLOW;
    }

    default:
      return ALLOW;
  }
}

/** Tools whose decision depends on the element or page they act on. */
export function needsPageFacts(name: string): boolean {
  return ['click_element', 'press_key', 'type_text', 'clear_input', 'select_option'].includes(name);
}
