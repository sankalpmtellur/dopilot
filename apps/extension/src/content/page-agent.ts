import { redactSecrets, toolFailure } from '@dopilot/shared';
import type {
  ContentRequest,
  DescribeResult,
  ElementFacts,
  GroundedPoint,
  PageFacts,
  PressableKey,
  ToolResult,
  ViewportState,
  VisualSnapshot,
} from '@dopilot/shared';

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="combobox"]',
  '[role="searchbox"]',
  '[role="textbox"]',
  '[contenteditable="true"]',
  '[contenteditable=""]',
].join(',');

const CHALLENGE_SELECTOR = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="turnstile"]',
  'iframe[title*="captcha" i]',
  '.g-recaptcha',
  '.h-captcha',
  '.cf-turnstile',
  '#challenge-form',
].join(',');
const CHALLENGE_TEXT = /\b(i'?m not a robot|verify you are human|captcha)\b/i;

const SECRET_AUTOCOMPLETE = /(password|cc-|one-time-code|webauthn)/i;
const SECRET_NAME =
  /\b(pass(word|code|phrase)?|pwd|otp|cvv|cvc|card ?(number|no)|security code|ssn|social security|api[ _-]?key|secret|token|pin)\b/i;

const PAYMENT_FRAME = /stripe|paypal|braintree|adyen|checkout|payment|card|klarna|square/i;

const NAME_LIMIT = 120;
const ACTION_SETTLE_MS = 500;

export interface PageAgentOptions {
  /** Layout does not exist in test environments, so tests can treat everything as laid out. */
  isLaidOut?: (element: Element) => boolean;
  settleMs?: number;
}

function clean(value: string | null | undefined, limit = NAME_LIMIT): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function randomPrefix(): string {
  return Math.random().toString(36).slice(2, 8) || 'a';
}

/** Walks the page including open shadow roots, which many modern sites rely on. */
function* walk(root: ParentNode): Generator<Element> {
  for (const element of root.querySelectorAll('*')) {
    yield element;
    if (element.shadowRoot) yield* walk(element.shadowRoot);
  }
}

/**
 * Everything Dopilot does inside a webpage. Nothing here takes code or selectors from
 * the model: it only accepts fixed requests and references it handed out itself. Field
 * values are never reported, so passwords and personal data cannot reach the model.
 */
export function createPageAgent(options: PageAgentOptions = {}) {
  const prefix = randomPrefix();
  const refs = new WeakMap<Element, string>();
  const byRef = new Map<string, { element: WeakRef<Element>; name: string; role: string }>();
  let nextId = 1;
  const settleMs = options.settleMs ?? ACTION_SETTLE_MS;

  const isLaidOut =
    options.isLaidOut ??
    ((element: Element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

  function isVisible(element: Element): boolean {
    if (!element.isConnected) return false;
    if (element.closest('[hidden],[inert]')) return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none') return false;
      if (node === element && (style.visibility === 'hidden' || style.visibility === 'collapse')) {
        return false;
      }
    }
    return isLaidOut(element);
  }

  function labelFor(element: Element): string {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
        .join(' ');
      if (clean(text)) return clean(text);
    }
    const aria = clean(element.getAttribute('aria-label'));
    if (aria) return aria;

    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      const label = clean(element.labels?.[0]?.textContent);
      if (label) return label;
    }
    if (element instanceof HTMLInputElement) {
      if (['button', 'submit', 'reset'].includes(element.type)) {
        return clean(element.value) || clean(element.type);
      }
      if (element.type === 'image') return clean(element.alt);
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const placeholder = clean(element.placeholder);
      if (placeholder) return placeholder;
    }
    const text = clean(element.textContent);
    if (text) return text;
    const image = element.querySelector('img[alt]');
    return clean(image?.getAttribute('alt')) || clean(element.getAttribute('title'));
  }

  function roleOf(element: Element): string {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (element instanceof HTMLInputElement) {
      switch (element.type) {
        case 'button':
        case 'submit':
        case 'reset':
        case 'image':
          return 'button';
        case 'checkbox':
          return 'checkbox';
        case 'radio':
          return 'radio';
        case 'search':
          return 'searchbox';
        case 'range':
          return 'slider';
        case 'file':
          return 'file';
        default:
          return 'textbox';
      }
    }
    if ((element as HTMLElement).isContentEditable) return 'textbox';
    return tag;
  }

  function isSecretField(element: Element): boolean {
    if (element instanceof HTMLInputElement && element.type === 'password') return true;
    const autocomplete = element.getAttribute('autocomplete') ?? '';
    if (SECRET_AUTOCOMPLETE.test(autocomplete)) return true;
    if (!isTextEntry(element)) return false;
    const hints = [
      element.getAttribute('name'),
      element.getAttribute('id'),
      element.getAttribute('aria-label'),
      labelFor(element),
    ].join(' ');
    return SECRET_NAME.test(hints.replace(/[_-]/g, ' '));
  }

  function isTextEntry(element: Element): boolean {
    if (element instanceof HTMLTextAreaElement) return true;
    if (element instanceof HTMLInputElement) {
      return ![
        'button',
        'submit',
        'reset',
        'image',
        'checkbox',
        'radio',
        'file',
        'range',
        'color',
      ].includes(element.type);
    }
    return (
      (element as HTMLElement).isContentEditable ||
      element.getAttribute('contenteditable') === 'true' ||
      element.getAttribute('contenteditable') === '' ||
      ['textbox', 'searchbox'].includes(element.getAttribute('role') ?? '')
    );
  }

  function formOf(element: Element): HTMLFormElement | null {
    if (element instanceof HTMLInputElement || element instanceof HTMLButtonElement) {
      if (element.form) return element.form;
    }
    return element.closest('form');
  }

  function isSearchForm(form: HTMLFormElement | null, element: Element): boolean {
    if (!form) return false;
    if (form.querySelector('input[type="password"]')) return false;
    const method = (form.getAttribute('method') ?? 'get').toLowerCase();
    if (method !== 'get') return false;
    return (
      form.getAttribute('role') === 'search' ||
      form.closest('[role="search"]') !== null ||
      element.getAttribute('role') === 'searchbox' ||
      form.querySelector('input[type="search"],[role="searchbox"]') !== null ||
      /search/i.test(`${form.getAttribute('action') ?? ''} ${form.id} ${form.className}`) ||
      form.querySelector('input[name="q"],input[name="search"],input[name="query"]') !== null
    );
  }

  function isChallengeElement(element: Element): boolean {
    return (
      element.closest(CHALLENGE_SELECTOR) !== null ||
      CHALLENGE_TEXT.test(labelFor(element)) ||
      /captcha/i.test(`${element.id} ${element.getAttribute('name') ?? ''}`)
    );
  }

  function hasChallenge(): boolean {
    for (const element of document.querySelectorAll(CHALLENGE_SELECTOR)) {
      if (isVisible(element)) return true;
    }
    return /^(just a moment|attention required|verify you are human)/i.test(document.title);
  }

  function refFor(element: Element): string {
    const existing = refs.get(element);
    if (existing) return existing;
    const ref = `${prefix}.${nextId++}`;
    refs.set(element, ref);
    byRef.set(ref, {
      element: new WeakRef(element),
      name: labelFor(element),
      role: roleOf(element),
    });
    return ref;
  }

  /** Revalidates a reference, so an action never lands on the wrong element. */
  function resolve(ref: string): { element: Element } | { failure: ToolResult } {
    const entry = byRef.get(ref);
    const element = entry?.element.deref();
    if (!entry || !element || !element.isConnected) {
      return {
        failure: toolFailure(
          'stale_ref',
          'That element is no longer on the page. Call get_interactive_elements again.',
        ),
      };
    }
    if (roleOf(element) !== entry.role || labelFor(element) !== entry.name) {
      // Sites reuse elements for different things, so a changed label needs a fresh look.
      entry.name = labelFor(element);
      entry.role = roleOf(element);
      return {
        failure: toolFailure(
          'element_changed',
          `That element changed and is now “${entry.name}”. Check it is still what you want.`,
        ),
      };
    }
    if (!isVisible(element)) {
      return {
        failure: toolFailure('element_hidden', 'That element is not visible right now.'),
      };
    }
    return { element };
  }

  function isDisabled(element: Element): boolean {
    return (
      (element as HTMLButtonElement).disabled === true ||
      element.getAttribute('aria-disabled') === 'true'
    );
  }

  function pageFacts(): PageFacts {
    const headings = [...document.querySelectorAll('h1,h2,h3')]
      .filter(isVisible)
      .slice(0, 8)
      .map((heading) => clean(heading.textContent));
    return {
      url: location.href.split(/[?#]/, 1)[0] ?? '',
      title: clean(document.title, 200),
      headings,
      hasChallenge: hasChallenge(),
    };
  }

  function elementFacts(element: Element): ElementFacts {
    const form = formOf(element);
    const isButtonLike =
      element instanceof HTMLButtonElement
        ? element.type === 'submit'
        : element instanceof HTMLInputElement && ['submit', 'image'].includes(element.type);
    const href = element.closest('a[href]') as HTMLAnchorElement | null;
    return {
      tag: element.tagName.toLowerCase(),
      role: roleOf(element),
      name: labelFor(element),
      inputType: element instanceof HTMLInputElement ? element.type : null,
      href: href ? (href.href.split(/[?#]/, 1)[0] ?? null) : null,
      isSubmit: isButtonLike,
      inForm: form !== null,
      isSearchForm: isSearchForm(form, element),
      isFileInput: element instanceof HTMLInputElement && element.type === 'file',
      isSecretField: isSecretField(element),
      isChallenge: isChallengeElement(element),
    };
  }

  /** Reports what an action actually did, so nothing is claimed that did not happen. */
  async function observeEffect(
    act: () => void,
  ): Promise<{ urlChanged: boolean; domChanged: boolean }> {
    const urlBefore = location.href;
    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    act();
    await new Promise((done) => setTimeout(done, settleMs));
    observer.disconnect();
    return { urlChanged: location.href !== urlBefore, domChanged: mutations > 0 };
  }

  function scrollIntoView(element: Element): void {
    element.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'instant' });
  }

  function isCovered(element: Element): boolean {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const root = element.getRootNode() as Document | ShadowRoot;
    const top = root.elementFromPoint?.(x, y);
    if (!top) return false;
    return !(top === element || element.contains(top) || top.contains(element));
  }

  function dispatchClick(element: Element): void {
    const init = { bubbles: true, cancelable: true, composed: true };
    element.dispatchEvent(new PointerEvent('pointerdown', init));
    element.dispatchEvent(new MouseEvent('mousedown', init));
    (element as HTMLElement).focus?.({ preventScroll: true });
    element.dispatchEvent(new PointerEvent('pointerup', init));
    element.dispatchEvent(new MouseEvent('mouseup', init));
    (element as HTMLElement).click();
  }

  async function click(ref: string): Promise<ToolResult> {
    const resolved = resolve(ref);
    if ('failure' in resolved) return resolved.failure;
    const { element } = resolved;
    if (isDisabled(element)) return toolFailure('element_disabled', 'That control is disabled.');

    scrollIntoView(element);
    if (isCovered(element)) {
      return toolFailure(
        'element_covered',
        'Something is covering that element, such as a popup. Deal with that first.',
      );
    }

    const name = labelFor(element);
    const { urlChanged, domChanged } = await observeEffect(() => dispatchClick(element));
    if (urlChanged) {
      return {
        ok: true,
        summary: `Clicked “${name}”. The address changed.`,
        pageChanged: true,
      };
    }
    return {
      ok: true,
      summary: domChanged
        ? `Clicked “${name}”. The page updated.`
        : `Clicked “${name}”, but nothing visibly changed. It may not have worked.`,
      pageChanged: domChanged,
    };
  }

  function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    // Uses the prototype's setter, because frameworks like React wrap the one on the element.
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function typeInto(ref: string, text: string): ToolResult {
    const resolved = resolve(ref);
    if ('failure' in resolved) return resolved.failure;
    const { element } = resolved;

    if (isSecretField(element)) {
      return toolFailure(
        'secret_field',
        'Dopilot does not fill in passwords, card numbers or security codes.',
        false,
      );
    }
    if (!isTextEntry(element))
      return toolFailure('not_editable', 'That element does not take text.');
    if (isDisabled(element) || (element as HTMLInputElement).readOnly) {
      return toolFailure('element_disabled', 'That field cannot be edited.');
    }

    scrollIntoView(element);
    (element as HTMLElement).focus?.({ preventScroll: true });

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      setNativeValue(element, text);
      if (element.value !== text) {
        return toolFailure('type_failed', 'The field did not accept that text.');
      }
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      const inserted = text
        ? document.execCommand?.('insertText', false, text)
        : document.execCommand?.('delete');
      if (!inserted) element.textContent = text;
      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      if (clean(element.textContent, 20000) !== clean(text, 20000)) {
        return toolFailure('type_failed', 'The field did not accept that text.');
      }
    }
    return {
      ok: true,
      summary: text ? `Typed into “${labelFor(element)}”.` : `Cleared “${labelFor(element)}”.`,
    };
  }

  function selectOption(ref: string, option: string): ToolResult {
    const resolved = resolve(ref);
    if ('failure' in resolved) return resolved.failure;
    const { element } = resolved;
    if (!(element instanceof HTMLSelectElement)) {
      return toolFailure('not_a_dropdown', 'That element is not a dropdown. Try clicking it.');
    }
    if (isDisabled(element)) return toolFailure('element_disabled', 'That dropdown is disabled.');

    const wanted = option.trim().toLowerCase();
    const match = [...element.options].find(
      (candidate) =>
        clean(candidate.textContent).toLowerCase() === wanted ||
        candidate.value.toLowerCase() === wanted,
    );
    if (!match) {
      const choices = [...element.options].slice(0, 15).map((item) => clean(item.textContent, 40));
      return toolFailure('option_not_found', `No such option. Choices: ${choices.join(', ')}`);
    }

    element.value = match.value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, summary: `Chose “${clean(match.textContent)}”.`, pageChanged: true };
  }

  function findByText(text: string, role?: string): Element | null {
    const wanted = text.trim().toLowerCase();
    const roleMatches = (element: Element) => !role || roleOf(element) === role;
    const matches = (element: Element, exact: boolean) => {
      const name = labelFor(element).toLowerCase();
      return exact ? name === wanted : name.includes(wanted);
    };

    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')];
    const interactive = [...walk(document)].filter((element) =>
      element.matches(INTERACTIVE_SELECTOR),
    );
    const candidates = [...headings, ...interactive].filter(
      (element) => roleMatches(element) && isVisible(element),
    );
    const direct =
      candidates.find((element) => matches(element, true)) ??
      candidates.find((element) => matches(element, false));
    if (direct || role) return direct ?? null;

    // Falls back to the smallest visible block of text containing it.
    const blocks = document.querySelectorAll('p,li,dt,dd,td,th,label,figcaption,blockquote,span');
    for (const block of blocks) {
      if ((block.textContent ?? '').toLowerCase().includes(wanted) && isVisible(block))
        return block;
    }
    return null;
  }

  async function scroll(
    request: Extract<ContentRequest, { type: 'content.scroll' }>,
  ): Promise<ToolResult> {
    const before = window.scrollY;
    const settle = () => new Promise((done) => setTimeout(done, Math.min(settleMs, 200)));

    if (request.ref) {
      const resolved = resolve(request.ref);
      if ('failure' in resolved) return resolved.failure;
      scrollIntoView(resolved.element);
      await settle();
      return { ok: true, summary: `Scrolled to “${labelFor(resolved.element)}”.` };
    }

    if (request.text) {
      const target = findByText(request.text);
      if (!target) {
        return toolFailure('text_not_found', `Could not find “${request.text}” on this page.`);
      }
      scrollIntoView(target);
      await settle();
      return { ok: true, summary: `Scrolled to “${clean(target.textContent, 80)}”.` };
    }

    const page = document.documentElement.scrollHeight;
    const step = window.innerHeight * 0.85;
    const top: Record<string, number> = {
      up: before - step,
      down: before + step,
      top: 0,
      bottom: page,
    };
    window.scrollTo({ top: top[request.direction ?? 'down'] ?? before, behavior: 'instant' });
    await settle();

    if (window.scrollY === before) {
      return {
        ok: true,
        summary: `Could not scroll ${request.direction} any further. Already at the limit.`,
      };
    }
    const percent = Math.round((window.scrollY / Math.max(1, page - window.innerHeight)) * 100);
    return { ok: true, summary: `Scrolled ${request.direction}, now ${percent}% down the page.` };
  }

  const KEY_INIT: Record<PressableKey, { key: string; code: string }> = {
    Enter: { key: 'Enter', code: 'Enter' },
    Escape: { key: 'Escape', code: 'Escape' },
    Tab: { key: 'Tab', code: 'Tab' },
    Space: { key: ' ', code: 'Space' },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp' },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown' },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft' },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight' },
    PageUp: { key: 'PageUp', code: 'PageUp' },
    PageDown: { key: 'PageDown', code: 'PageDown' },
    Home: { key: 'Home', code: 'Home' },
    End: { key: 'End', code: 'End' },
  };

  function focused(): Element {
    return document.activeElement ?? document.body;
  }

  async function press(key: PressableKey, ref?: string): Promise<ToolResult> {
    let target = focused();
    if (ref) {
      const resolved = resolve(ref);
      if ('failure' in resolved) return resolved.failure;
      target = resolved.element;
      (target as HTMLElement).focus?.({ preventScroll: true });
    }

    const init = { ...KEY_INIT[key], bubbles: true, cancelable: true, composed: true };
    const { urlChanged, domChanged } = await observeEffect(() => {
      const proceed = target.dispatchEvent(new KeyboardEvent('keydown', init));
      target.dispatchEvent(new KeyboardEvent('keyup', init));
      if (!proceed) return;

      // Scripted key events do not trigger browser defaults, so these are done directly.
      if (key === 'Enter') {
        const form = formOf(target);
        if (form && target.tagName !== 'TEXTAREA') {
          form.requestSubmit();
        } else if (target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement) {
          target.click();
        }
      } else if (key === 'Space' && target instanceof HTMLButtonElement) {
        target.click();
      } else if (key === 'PageDown' || key === 'PageUp') {
        window.scrollBy({ top: (key === 'PageDown' ? 1 : -1) * window.innerHeight * 0.85 });
      }
    });

    if (urlChanged)
      return { ok: true, summary: `Pressed ${key}. The address changed.`, pageChanged: true };
    return {
      ok: true,
      summary: domChanged
        ? `Pressed ${key}. The page updated.`
        : `Pressed ${key}. Nothing visibly changed.`,
      pageChanged: domChanged,
    };
  }

  function describeInteractive(element: Element) {
    const entry: Record<string, unknown> = {
      ref: refFor(element),
      role: roleOf(element),
      name: labelFor(element),
    };
    if (isDisabled(element)) entry.disabled = true;
    if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) {
      entry.checked = element.checked;
    }
    if (isSecretField(element)) {
      entry.secret = true;
    } else if (element instanceof HTMLSelectElement) {
      entry.selected = clean(element.selectedOptions[0]?.textContent, 60);
    } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      // Whether it has a value, never the value: fields often hold personal data.
      if (element.value && isTextEntry(element)) entry.filled = true;
    }
    const link = element.closest('a[href]') as HTMLAnchorElement | null;
    if (link) entry.href = link.pathname === '/' ? link.origin : link.pathname;
    return entry;
  }

  function interactive(limit: number, query?: string): ToolResult {
    const wanted = query?.trim().toLowerCase();
    const viewportHeight = window.innerHeight;
    const elements = [...walk(document)]
      .filter((element) => element.matches(INTERACTIVE_SELECTOR))
      .filter((element) => isVisible(element) && !isChallengeElement(element))
      .filter((element) => labelFor(element) || isTextEntry(element))
      .filter((element) => !wanted || labelFor(element).toLowerCase().includes(wanted));

    // What the user can see comes first, since it is what they are talking about.
    const onScreen = (element: Element) => {
      const { top, bottom } = element.getBoundingClientRect();
      return bottom >= 0 && top <= viewportHeight;
    };
    const ordered = [...elements.filter(onScreen), ...elements.filter((item) => !onScreen(item))];

    const list = ordered.slice(0, limit).map(describeInteractive);
    return {
      ok: true,
      summary: `Found ${elements.length} controls${
        elements.length > limit ? `, showing ${limit}. Use query to narrow it down` : ''
      }.`,
      data: { elements: list, securityCheck: hasChallenge() || undefined },
      untrusted: true,
    };
  }

  function metadata(): ToolResult {
    const description = document.querySelector('meta[name="description"]')?.getAttribute('content');
    const forms = [...document.querySelectorAll('form')]
      .filter(isVisible)
      .slice(0, 5)
      .map((form) => ({
        name: clean(form.getAttribute('aria-label') ?? form.getAttribute('name') ?? form.id, 60),
        fields: form.querySelectorAll('input:not([type="hidden"]),select,textarea').length,
        search: isSearchForm(form, form),
      }));
    const headings = [...document.querySelectorAll('h1,h2,h3')]
      .filter(isVisible)
      .slice(0, 25)
      .map((heading) => ({
        level: Number(heading.tagName[1]),
        text: clean(heading.textContent, 100),
      }));
    return {
      ok: true,
      summary: `Read details of “${clean(document.title, 60)}”.`,
      data: {
        title: clean(document.title, 200),
        url: location.href.split(/[?#]/, 1)[0],
        description: redactSecrets(clean(description, 300)),
        headings,
        forms,
        securityCheck: hasChallenge() || undefined,
      },
      untrusted: true,
    };
  }

  function collectText(root: Element, onlyVisible: boolean, maxChars: number): string {
    const parts: string[] = [];
    let length = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !clean(node.textContent)) return NodeFilter.FILTER_REJECT;
        if (parent.closest('script,style,noscript,template,svg,textarea,input,select,option')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const viewportHeight = window.innerHeight;
    while (walker.nextNode() && length < maxChars) {
      const parent = walker.currentNode.parentElement;
      if (!parent || !isVisible(parent)) continue;
      if (onlyVisible) {
        const { top, bottom } = parent.getBoundingClientRect();
        if (bottom < 0 || top > viewportHeight) continue;
      }
      const text = clean(walker.currentNode.textContent, 1000);
      parts.push(text);
      length += text.length + 1;
    }
    return redactSecrets(parts.join(' ').slice(0, maxChars));
  }

  function pageContent(maxChars: number): ToolResult {
    const root =
      document.querySelector('main,[role="main"],article,#content,#main') ?? document.body;
    const text = collectText(root, false, maxChars) || collectText(document.body, false, maxChars);
    return {
      ok: true,
      summary: text ? `Read ${text.length} characters.` : 'This page has no readable text.',
      data: { text },
      untrusted: true,
    };
  }

  function visibleText(maxChars: number): ToolResult {
    const text = collectText(document.body, true, maxChars);
    return {
      ok: true,
      summary: text ? `Read ${text.length} visible characters.` : 'No text is visible.',
      data: { text },
      untrusted: true,
    };
  }

  function waitFor(
    request: Extract<ContentRequest, { type: 'content.wait' }>,
  ): Promise<ToolResult> {
    const find = () => {
      if (request.text) return findByText(request.text, request.role);
      return (
        [...walk(document)].find(
          (element) => roleOf(element) === request.role && isVisible(element),
        ) ?? null
      );
    };
    const found = (element: Element): ToolResult => ({
      ok: true,
      summary: `Found “${labelFor(element)}”.`,
      data: element.matches(INTERACTIVE_SELECTOR) ? describeInteractive(element) : undefined,
      untrusted: true,
    });

    const immediate = find();
    if (immediate) return Promise.resolve(found(immediate));

    return new Promise((resolvePromise) => {
      let finished = false;
      const finish = (result: ToolResult) => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearTimeout(timer);
        resolvePromise(result);
      };
      // Dynamic sites add content whenever they like, so this reacts to changes.
      const observer = new MutationObserver(() => {
        const element = find();
        if (element) finish(found(element));
      });
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
      });
      const timer = setTimeout(
        () =>
          finish(
            toolFailure(
              'element_not_found',
              `Nothing matching appeared within ${Math.round(request.timeoutMs / 1000)}s.`,
            ),
          ),
        request.timeoutMs,
      );
    });
  }

  function colorName(element: Element): string | undefined {
    const style = getComputedStyle(element);
    const parse = (value: string) => {
      const match = /rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)(?:[,/ ]+([\d.]+))?/.exec(value);
      if (!match) return null;
      const alpha = match[4] === undefined ? 1 : Number(match[4]);
      return alpha < 0.3 ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
    };
    const rgb = parse(style.backgroundColor) ?? parse(style.fill) ?? parse(style.color);
    if (!rgb) return undefined;
    const [r = 0, g = 0, b = 0] = rgb;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < 50) return 'black';
    if (min > 215) return 'white';
    if (max - min < 25) return 'gray';
    const delta = max - min;
    const hue =
      max === r
        ? (((g - b) / delta) % 6) * 60
        : max === g
          ? ((b - r) / delta + 2) * 60
          : ((r - g) / delta + 4) * 60;
    const angle = (hue + 360) % 360;
    if (angle < 15 || angle >= 345) return 'red';
    if (angle < 45) return 'orange';
    if (angle < 70) return 'yellow';
    if (angle < 165) return 'green';
    if (angle < 200) return 'cyan';
    if (angle < 260) return 'blue';
    if (angle < 300) return 'purple';
    return 'pink';
  }

  function boxOf(element: Element): [number, number, number, number] {
    const { left, top, width, height } = element.getBoundingClientRect();
    return [Math.round(left), Math.round(top), Math.round(width), Math.round(height)];
  }

  function onScreen(element: Element): boolean {
    const { top, bottom, left, right, width, height } = element.getBoundingClientRect();
    // Zero-size boxes have already been judged by the visibility check.
    if (width === 0 && height === 0) return true;
    return bottom > 0 && right > 0 && top < window.innerHeight && left < window.innerWidth;
  }

  function visibleControls(): Element[] {
    return [...walk(document)].filter(
      (element) =>
        element.matches(INTERACTIVE_SELECTOR) &&
        isVisible(element) &&
        onScreen(element) &&
        !isChallengeElement(element),
    );
  }

  function viewportState(): ViewportState {
    const signature = visibleControls()
      .map((element) => {
        const [x, y, w, h] = boxOf(element);
        const grid = (value: number) => Math.round(value / 8);
        return `${roleOf(element)}|${labelFor(element)}|${grid(x)},${grid(y)},${grid(w)},${grid(h)}`;
      })
      .join(';');
    let hash = 0;
    for (let index = 0; index < signature.length; index += 1) {
      hash = (Math.imul(hash, 31) + signature.charCodeAt(index)) | 0;
    }
    return {
      url: location.href.split(/[?#]/, 1)[0] ?? '',
      title: clean(document.title, 200),
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      dpr: window.devicePixelRatio || 1,
      fingerprint: hash.toString(36),
    };
  }

  /**
   * Everything needed to photograph a page safely and tie what a model sees back to real
   * elements. Secret fields are reported so they can be painted over. So are frames that
   * look like payment forms, because their contents cannot be inspected from here.
   */
  function visualSnapshot(limit: number): VisualSnapshot {
    const elements = visibleControls()
      .slice(0, limit)
      .map((element) => {
        const color = colorName(element);
        return {
          ref: refFor(element),
          role: roleOf(element),
          name: labelFor(element),
          box: boxOf(element),
          ...(color && { color }),
        };
      });
    const secretBoxes = [...walk(document)]
      .filter((element) => {
        if (!isVisible(element) || !onScreen(element)) return false;
        if (element.tagName === 'IFRAME') {
          const hints = `${element.getAttribute('src') ?? ''} ${element.getAttribute('name') ?? ''} ${element.getAttribute('title') ?? ''}`;
          return PAYMENT_FRAME.test(hints);
        }
        return isSecretField(element);
      })
      .map(boxOf);
    const frameCount = [...walk(document)].filter(
      (element) => element.tagName === 'IFRAME' && isVisible(element) && onScreen(element),
    ).length;
    return {
      viewport: viewportState(),
      hasChallenge: hasChallenge(),
      elements,
      secretBoxes,
      frameCount,
    };
  }

  /** Finds what is really at a point, so a visual target is never clicked blind. */
  function groundPoint(x: number, y: number): GroundedPoint {
    let element = document.elementFromPoint?.(x, y) ?? null;
    while (element?.shadowRoot) {
      const inner = element.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === element) break;
      element = inner;
    }
    if (!element || element === document.documentElement || element === document.body) {
      return { kind: 'nothing' };
    }
    if (element.tagName === 'IFRAME' || element.tagName === 'FRAME') return { kind: 'frame' };

    const control = element.closest(INTERACTIVE_SELECTOR);
    return control
      ? { kind: 'element', ref: refFor(control), interactive: true }
      : { kind: 'element', ref: refFor(element), interactive: false };
  }

  /** For things drawn on a canvas and the like, which only make sense with coordinates. */
  async function clickPoint(ref: string, x: number, y: number): Promise<ToolResult> {
    const resolved = resolve(ref);
    if ('failure' in resolved) return resolved.failure;
    const { element } = resolved;
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y };
    const { urlChanged, domChanged } = await observeEffect(() => {
      element.dispatchEvent(new PointerEvent('pointerdown', init));
      element.dispatchEvent(new MouseEvent('mousedown', init));
      element.dispatchEvent(new PointerEvent('pointerup', init));
      element.dispatchEvent(new MouseEvent('mouseup', init));
      element.dispatchEvent(new MouseEvent('click', init));
    });
    if (urlChanged)
      return { ok: true, summary: 'Clicked. The address changed.', pageChanged: true };
    return {
      ok: true,
      summary: domChanged
        ? 'Clicked. The page updated.'
        : 'Clicked, but nothing visibly changed. It may not have worked.',
      pageChanged: domChanged,
    };
  }

  function describe(ref?: string): DescribeResult | ToolResult {
    if (!ref) {
      const active = focused();
      const element = active === document.body ? null : elementFacts(active);
      return { element, page: pageFacts() };
    }
    const resolved = resolve(ref);
    if ('failure' in resolved) return resolved.failure;
    return { element: elementFacts(resolved.element), page: pageFacts() };
  }

  async function handle(request: ContentRequest): Promise<ToolResult> {
    switch (request.type) {
      case 'content.ping':
        return { ok: true, summary: 'ready' };
      case 'content.viewport':
        return { ok: true, summary: 'viewport', data: viewportState() };
      case 'content.visual_snapshot':
        return { ok: true, summary: 'snapshot', data: visualSnapshot(request.limit) };
      case 'content.ground_point':
        return { ok: true, summary: 'grounded', data: groundPoint(request.x, request.y) };
      case 'content.click_point':
        return clickPoint(request.ref, request.x, request.y);
      case 'content.metadata':
        return metadata();
      case 'content.page_content':
        return pageContent(request.maxChars);
      case 'content.visible_text':
        return visibleText(request.maxChars);
      case 'content.interactive':
        return interactive(request.limit, request.query);
      case 'content.describe': {
        const result = describe(request.ref);
        return 'ok' in result ? result : { ok: true, summary: 'described', data: result };
      }
      case 'content.click':
        return click(request.ref);
      case 'content.type':
        return typeInto(request.ref, request.text);
      case 'content.clear':
        return typeInto(request.ref, '');
      case 'content.select':
        return selectOption(request.ref, request.option);
      case 'content.scroll':
        return scroll(request);
      case 'content.press':
        return press(request.key, request.ref);
      case 'content.wait':
        return waitFor(request);
    }
  }

  return { handle };
}
