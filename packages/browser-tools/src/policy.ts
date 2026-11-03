import type { DescribeResult, ElementFacts, PageFacts } from '@dopilot/shared';

export type ApprovalCategory =
  | 'form_submission'
  | 'purchase'
  | 'account_change'
  | 'send_message'
  | 'file_upload'
  | 'destructive'
  | 'confirmation'
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
  /** Where the task is now. Moving within one site cannot carry its data anywhere new. */
  currentUrl?: string;
}

const ALLOW: PolicyDecision = { decision: 'allow' };

/**
 * Whole words in any alphabet. `\b` only understands ASCII, so it would split "löschen" in two.
 * Scripts written without spaces between words are matched anywhere instead.
 */
function words(spaced: string[], unspaced: string[] = []): RegExp {
  const bounded = `(?<![\\p{L}\\p{N}])(?:${spaced.join('|')})(?![\\p{L}\\p{N}])`;
  return new RegExp(unspaced.length > 0 ? `${bounded}|${unspaced.join('|')}` : bounded, 'iu');
}

const RULES: [ApprovalCategory, RegExp, string][] = [
  [
    'purchase',
    words(
      [
        'buy|purchase|checkout|check ?out|place (your )?order|pay|pay now|order now|confirm order',
        'subscribe|donate|add payment|start (free )?trial|payment|transfer|wire|withdraw(al)?|remit',
        'send money|top up|deposit|(continue|proceed) to (payment|checkout)|complete (purchase|order)',
        // Spanish and Portuguese, French, German, Italian, Russian.
        'comprar|pagar|pago|finalizar compra|realizar pedido|transferir|retirar|suscribirse|assinar',
        'acheter|payer|paiement|commander|virement|transférer|s.abonner',
        'kaufen|jetzt kaufen|bezahlen|zahlen|zur kasse|überweisen|überweisung|bestellen|abonnieren',
        'acquista|compra|paga|pagamento|bonifico|trasferisci',
        'купить|оплатить|оплата|перевести|заказать',
      ],
      // Chinese, Japanese, Korean, Hindi, Arabic.
      [
        '购买|支付|付款|结算|转账|提现|下单|订阅',
        '購入|支払|決済|振込|注文',
        '구매|결제|송금|주문',
        'खरीद|भुगतान|स्थानांतरण',
        'شراء|ادفع|دفع|تحويل',
      ],
    ),
    'This looks like it spends or moves money.',
  ],
  [
    'send_message',
    words(
      [
        'send|post|publish|tweet|reply|comment|share|invite|email',
        'enviar|publicar|responder|compartir|compartilhar',
        'envoyer|publier|répondre|partager',
        'senden|absenden|veröffentlichen|antworten|teilen',
        'invia|pubblica|rispondi|condividi',
        'отправить|опубликовать|ответить',
      ],
      ['发送|发布|回复|分享', '送信|投稿|共有', '보내기|전송|게시', 'भेजें|भेजना', 'إرسال|نشر'],
    ),
    'This looks like it sends something to other people.',
  ],
  [
    'account_change',
    words(
      [
        'save changes|update (profile|account|settings|email|password)|change (password|email)',
        'sign out|log ?out|deactivate|close account|unsubscribe|enable|disable|grant|authorize',
        'allow access|accept terms|i agree',
        'cerrar sesión|guardar cambios|sair|se déconnecter|déconnexion',
        'abmelden|ausloggen|esci|disconnetti|выйти',
      ],
      ['退出登录|注销', 'ログアウト', '로그아웃', 'लॉग आउट', 'تسجيل الخروج'],
    ),
    'This looks like it changes your account.',
  ],
  [
    'destructive',
    words(
      [
        'delete|remove|discard|erase|destroy|clear all|reset|revoke|uninstall',
        'cancel (order|subscription|booking|plan)',
        'eliminar|borrar|excluir|apagar|remover',
        'supprimer|effacer',
        'löschen|entfernen',
        'elimina|cancella|rimuovi',
        'удалить',
      ],
      ['删除|移除|清空', '削除', '삭제', 'हटाएं|मिटाएं', 'حذف'],
    ),
    'This looks like it deletes or undoes something.',
  ],
  [
    'file_upload',
    /\b(upload|attach|choose file|browse files)\b/i,
    'This looks like a file upload.',
  ],
  [
    'confirmation',
    words(
      [
        'confirm|i.m sure|yes,? (i.m sure|delete|continue|proceed|confirm)|submit',
        'confirmar|confirmer|valider|bestätigen|conferma|подтвердить',
      ],
      ['确认|确定', '確認', '확인', 'पुष्टि', 'تأكيد'],
    ),
    'This looks like it confirms something.',
  ],
];

/** Buttons that only back out. Asking first would just get in the way. */
const DISMISS = words([
  'cancel|close|dismiss|no|no,? thanks|not now|maybe later|later|back|go back|reject|decline',
  'keep|stay|x|×|cancelar|annuler|abbrechen|annulla|отмена|schließen|fermer|cerrar',
]);
/** Answers that only mean something because of the question above them. */
const AFFIRMATIVE = words([
  'yes|ok|okay|sure|continue|proceed|accept|agree|allow|next|done|sí|oui|ja',
]);
const CONSENT_DIALOG = /\bcookies?\b/i;

/** Pages where a button is likely to matter, whatever it is called. Text, not code, so it can miss. */
const SENSITIVE_PAGE = words(
  [
    'checkout|check-?out|payment|payments|billing|transfer|wire|wallet|withdraw(al)?',
    'zahlung|paiement|pago|pagamento|kasse|оплата',
  ],
  ['支付|结算|支払|決済|결제|भुगतान'],
);

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
  return assessContext(element, page);
}

/**
 * Keywords cannot cover every label or language, so this looks at where a control is. These
 * facts come from the page's structure, which is much harder to word around than a label.
 */
function assessContext(element: ElementFacts, page: PageFacts): PolicyDecision {
  const name = element.name.trim();
  const dismisses = name !== '' && DISMISS.test(name) && !AFFIRMATIVE.test(name);
  if (dismisses) return ALLOW;

  const isControl = element.role === 'button' || element.isSubmit;

  // A nameless control gets a look at its attributes, such as class="icon-trash".
  if (!name && isControl && element.hints) {
    for (const [category, pattern] of RULES) {
      if (pattern.test(element.hints.replace(/[-_]+/g, ' '))) {
        return {
          decision: 'approve',
          category,
          reason: 'This control has no label, and its attributes suggest it matters.',
        };
      }
    }
  }

  if (element.inDialog) {
    const text = element.dialogText ?? '';
    const consequential = RULES.some(([, pattern]) => pattern.test(text));
    const consentOnly = CONSENT_DIALOG.test(text) && !consequential;
    if (!consentOnly && (consequential || !name || AFFIRMATIVE.test(name))) {
      return {
        decision: 'approve',
        category: 'confirmation',
        reason: text
          ? `This answers a dialog that says: “${text.slice(0, 160)}”`
          : 'This answers a dialog.',
      };
    }
  }

  if (isControl && element.formHasSecret) {
    return {
      decision: 'approve',
      category: 'form_submission',
      reason: 'This form has password or payment fields.',
    };
  }

  if (isControl && SENSITIVE_PAGE.test([page.url, page.title, ...page.headings].join(' '))) {
    return {
      decision: 'approve',
      category: 'purchase',
      reason: 'This page looks like it handles payments, so its buttons need your approval.',
    };
  }

  if (!name && isControl && element.inForm) {
    return {
      decision: 'approve',
      category: 'form_submission',
      reason: 'This unlabelled control is part of a form.',
    };
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

/** Long enough to carry something worth stealing. Paths are wordier than parameters. */
const MIN_PATH_DATA_CHARS = 16;
const MIN_PARAM_DATA_CHARS = 8;
/** Short, but exactly what someone would want: an email, a code, a number. */
const SENSITIVE_VALUE = /@|\d{4,}/;

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

function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * Once a task has read a webpage, an address the model builds might be what that page told
 * it to build, with the user's data in it or pointing at their router. Whatever came from
 * the user's own instruction is fine. Naming a site does not excuse what is sent to it, since
 * a page can suggest a site the user mentioned. Anything else is theirs to approve.
 */
function assessAfterReading(url: string, context: PolicyContext): PolicyDecision {
  const instruction = context.instruction ?? '';
  let parsed: URL;
  try {
    parsed = new URL(url.includes('://') ? url : `https://${url}`);
  } catch {
    return ALLOW;
  }
  // Moving around one site sends it nothing it did not already have.
  if (context.currentUrl) {
    try {
      if (new URL(context.currentUrl).origin === parsed.origin) return ALLOW;
    } catch {
      // An unreadable current address proves nothing, so this is treated as another site.
    }
  }

  const named = appearsIn(instruction, parsed.hostname.replace(/^www\./, ''));
  if (isPrivateHost(parsed.hostname) && !named) {
    return {
      decision: 'approve',
      category: 'data_in_address',
      reason: 'A page led here, and this address is on your own network.',
    };
  }

  const params = [...parsed.searchParams.values(), parsed.hash.slice(1)].map(decoded);
  const hostLabels = parsed.hostname.split('.').slice(0, -2);
  const path = parsed.pathname.split('/').map(decoded);
  const carries = (value: string, min: number) =>
    (value.length >= min || SENSITIVE_VALUE.test(value)) && !appearsIn(instruction, value);
  if (
    [...params, ...hostLabels].some((value) => carries(value, MIN_PARAM_DATA_CHARS)) ||
    path.some((value) => carries(value, MIN_PATH_DATA_CHARS))
  ) {
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
  if (context?.pageDataRead) return assessAfterReading(url, context);
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
