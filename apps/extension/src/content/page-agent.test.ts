// @vitest-environment jsdom
import type { DescribeResult, ToolResult } from '@dopilot/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPageAgent } from './page-agent';

type Agent = ReturnType<typeof createPageAgent>;
interface Item {
  ref: string;
  role: string;
  name: string;
  secret?: boolean;
  filled?: boolean;
  selected?: string;
  checked?: boolean;
}

let agent: Agent;

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = 'Test page';
  agent = createPageAgent({ isLaidOut: () => true, settleMs: 5 });
  Element.prototype.scrollIntoView = vi.fn();
  window.scrollTo = vi.fn() as never;
});

afterEach(() => vi.restoreAllMocks());

async function list(query?: string): Promise<Item[]> {
  const result = await agent.handle({
    type: 'content.interactive',
    limit: 50,
    ...(query && { query }),
  });
  if (!result.ok) throw new Error(result.message);
  return (result.data as { elements: Item[] }).elements;
}

async function refOf(name: string): Promise<string> {
  const item = (await list()).find((candidate) => candidate.name === name);
  if (!item) throw new Error(`No element named ${name}`);
  return item.ref;
}

async function describeRef(ref: string): Promise<DescribeResult> {
  const result = await agent.handle({ type: 'content.describe', ref });
  if (!result.ok) throw new Error(result.message);
  return result.data as DescribeResult;
}

describe('observing a page', () => {
  it('finds controls with accessible names and roles', async () => {
    document.body.innerHTML = `
      <button>Sign in</button>
      <a href="/docs">Docs</a>
      <button aria-label="Close dialog"><svg></svg></button>
      <label for="city">City</label><input id="city" />
      <input placeholder="Search the site" type="search" />
      <div role="button" aria-labelledby="l">x</div><span id="l">Labelled</span>
      <select aria-label="Sort"><option>Newest</option></select>
      <input type="checkbox" aria-label="Agree" checked />
    `;
    const items = await list();
    const byName = (name: string) => items.find((item) => item.name === name);

    expect(byName('Sign in')?.role).toBe('button');
    expect(byName('Docs')?.role).toBe('link');
    expect(byName('Close dialog')?.role).toBe('button');
    expect(byName('City')?.role).toBe('textbox');
    expect(byName('Search the site')?.role).toBe('searchbox');
    expect(byName('Labelled')?.role).toBe('button');
    expect(byName('Sort')?.selected).toBe('Newest');
    expect(byName('Agree')?.checked).toBe(true);
    for (const item of items) expect(item.ref).toMatch(/^[a-z0-9]+\.\d+$/);
  });

  it('skips hidden elements', async () => {
    document.body.innerHTML = `
      <button style="display:none">Hidden 1</button>
      <div style="display:none"><button>Hidden 2</button></div>
      <button style="visibility:hidden">Hidden 3</button>
      <button hidden>Hidden 4</button>
      <input type="hidden" name="csrf" value="token" />
      <button>Shown</button>
    `;
    expect((await list()).map((item) => item.name)).toEqual(['Shown']);
  });

  it('finds controls inside open shadow roots', async () => {
    const host = document.createElement('div');
    host.attachShadow({ mode: 'open' }).innerHTML = '<button>In shadow</button>';
    document.body.append(host);
    expect((await list()).map((item) => item.name)).toEqual(['In shadow']);
  });

  it('filters by name, and limits how much is returned', async () => {
    document.body.innerHTML = Array.from(
      { length: 80 },
      (_, index) => `<button>Item ${index}</button>`,
    ).join('');
    expect(await list('Item 79')).toHaveLength(1);
    const result = await agent.handle({ type: 'content.interactive', limit: 10 });
    expect(result.ok && (result.data as { elements: Item[] }).elements).toHaveLength(10);
    expect(result.ok && result.summary).toMatch(/showing 10/);
  });

  it('keeps refs stable between looks, and unique per document', async () => {
    document.body.innerHTML = '<button>One</button>';
    const first = await refOf('One');
    expect(await refOf('One')).toBe(first);
    const other = createPageAgent({ isLaidOut: () => true });
    const result = await other.handle({ type: 'content.interactive', limit: 5 });
    const second = result.ok && (result.data as { elements: Item[] }).elements[0]?.ref;
    expect(second).not.toBe(first);
  });

  it('reads headings, forms and metadata', async () => {
    document.head.innerHTML = '<meta name="description" content="A useful guide" />';
    document.title = 'Guide';
    document.body.innerHTML = `
      <h1>Main</h1><h2>History</h2>
      <form role="search"><input name="q" /></form>
    `;
    const result = await agent.handle({ type: 'content.metadata' });
    expect(result).toMatchObject({
      ok: true,
      untrusted: true,
      data: {
        title: 'Guide',
        description: 'A useful guide',
        headings: [
          { level: 1, text: 'Main' },
          { level: 2, text: 'History' },
        ],
        forms: [{ fields: 1, search: true }],
      },
    });
  });

  it('reads text as untrusted, and leaves out scripts and hidden text', async () => {
    document.body.innerHTML = `
      <main><p>Visible words</p><p style="display:none">Hidden instructions</p>
      <script>var secret = 1</script><style>.x{}</style></main>
    `;
    const result = await agent.handle({ type: 'content.page_content', maxChars: 1000 });
    const text = result.ok ? (result.data as { text: string }).text : '';
    expect(result).toMatchObject({ ok: true, untrusted: true });
    expect(text).toContain('Visible words');
    expect(text).not.toContain('Hidden instructions');
    expect(text).not.toContain('secret');
  });

  it('limits how much text is read', async () => {
    document.body.innerHTML = `<main><p>${'word '.repeat(5000)}</p></main>`;
    const result = await agent.handle({ type: 'content.page_content', maxChars: 200 });
    expect(result.ok && (result.data as { text: string }).text.length).toBeLessThanOrEqual(200);
  });
});

describe('privacy', () => {
  it('never reports field values, and flags secret fields', async () => {
    document.body.innerHTML = `
      <label>Password <input id="p" type="password" value="hunter2" /></label>
      <label>Email <input id="e" value="me@example.com" /></label>
      <label>Card number <input id="c" value="4111111111111111" /></label>
      <textarea aria-label="Notes">private note</textarea>
    `;
    const result = await agent.handle({ type: 'content.interactive', limit: 50 });
    const json = JSON.stringify(result);

    for (const value of ['hunter2', 'me@example.com', '4111111111111111', 'private note']) {
      expect(json).not.toContain(value);
    }
    const items = (result as { data: { elements: Item[] } }).data.elements;
    expect(items.find((item) => item.name.startsWith('Password'))?.secret).toBe(true);
    expect(items.find((item) => item.name.startsWith('Card'))?.secret).toBe(true);
    expect(items.find((item) => item.name === 'Email')).toMatchObject({ filled: true });
  });

  it('does not read field values as page text', async () => {
    document.body.innerHTML =
      '<main><p>Text</p><input value="secret value" /><textarea>note</textarea></main>';
    const result = await agent.handle({ type: 'content.page_content', maxChars: 500 });
    expect(JSON.stringify(result)).not.toContain('secret value');
    expect(JSON.stringify(result)).not.toContain('note');
  });

  it('removes card numbers and tokens from page text', async () => {
    document.body.innerHTML =
      '<main><p>Card 4111 1111 1111 1111 key gsk_abcdefghijklmnopqrstuvwxyz1234 end</p></main>';
    const result = await agent.handle({ type: 'content.page_content', maxChars: 500 });
    const text = JSON.stringify(result);
    expect(text).not.toContain('4111');
    expect(text).not.toContain('gsk_abc');
    expect(text).toContain('end');
  });

  it('refuses to type into secret fields, whatever they are called', async () => {
    document.body.innerHTML = `
      <input type="password" aria-label="Password field" />
      <input aria-label="Code" autocomplete="one-time-code" />
      <input aria-label="CVV" />
      <input aria-label="Name" autocomplete="cc-name" />
    `;
    for (const item of await list()) {
      const result = await agent.handle({ type: 'content.type', ref: item.ref, text: 'x' });
      expect(result).toMatchObject({ ok: false, code: 'secret_field' });
    }
    for (const input of document.querySelectorAll('input')) expect(input.value).toBe('');
  });

  it('does not put query strings in page facts', async () => {
    window.history.pushState({}, '', '/quiz?token=secret');
    const result = await agent.handle({ type: 'content.describe' });
    expect(JSON.stringify(result)).not.toContain('secret');
    window.history.pushState({}, '', '/');
  });
});

describe('clicking', () => {
  it('clicks the element and reports the update it caused', async () => {
    document.body.innerHTML = '<button id="b">Load more</button>';
    const button = document.querySelector('#b') as HTMLButtonElement;
    button.addEventListener('click', () => button.after(document.createElement('p')));

    const result = await agent.handle({ type: 'content.click', ref: await refOf('Load more') });
    expect(result).toMatchObject({ ok: true, pageChanged: true });
    expect(document.querySelector('p')).not.toBeNull();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('says so when a click did nothing visible', async () => {
    document.body.innerHTML = '<button>Dead</button>';
    const result = await agent.handle({ type: 'content.click', ref: await refOf('Dead') });
    expect(result.ok && result.summary).toMatch(/may not have worked/);
  });

  it('refuses disabled controls', async () => {
    document.body.innerHTML = '<button disabled>Off</button>';
    const result = await agent.handle({ type: 'content.click', ref: await refOf('Off') });
    expect(result).toMatchObject({ ok: false, code: 'element_disabled' });
  });

  it('reports an element covered by something else', async () => {
    document.body.innerHTML = '<button>Under</button><div id="overlay"></div>';
    const ref = await refOf('Under');
    const button = document.querySelector('button') as HTMLButtonElement;
    const clicked = vi.fn();
    button.addEventListener('click', clicked);
    button.getBoundingClientRect = () => new DOMRect(0, 0, 100, 40);
    document.elementFromPoint = () => document.querySelector('#overlay');

    const result = await agent.handle({ type: 'content.click', ref });
    expect(result).toMatchObject({ ok: false, code: 'element_covered' });
    expect(clicked).not.toHaveBeenCalled();
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });
});

describe('references on dynamic pages', () => {
  it('fails clearly when the element has gone, and does not click something else', async () => {
    document.body.innerHTML = '<button id="a">Save draft</button>';
    const ref = await refOf('Save draft');
    document.body.innerHTML = '<button>Other</button>';
    const result = await agent.handle({ type: 'content.click', ref });
    expect(result).toMatchObject({ ok: false, code: 'stale_ref' });
  });

  it('notices an element reused for something different', async () => {
    document.body.innerHTML = '<button id="a">Next</button>';
    const ref = await refOf('Next');
    const clicked = vi.fn();
    const button = document.querySelector('#a') as HTMLButtonElement;
    button.addEventListener('click', clicked);
    button.textContent = 'Delete everything';

    const result = await agent.handle({ type: 'content.click', ref });
    expect(result).toMatchObject({ ok: false, code: 'element_changed' });
    expect(result.ok === false && result.message).toContain('Delete everything');
    expect(clicked).not.toHaveBeenCalled();
  });

  it('notices an element that became hidden', async () => {
    document.body.innerHTML = '<button id="a">Go</button>';
    const ref = await refOf('Go');
    (document.querySelector('#a') as HTMLElement).style.display = 'none';
    const result = await agent.handle({ type: 'content.click', ref });
    expect(result).toMatchObject({ ok: false, code: 'element_hidden' });
  });

  it('rejects refs it never issued', async () => {
    const result = await agent.handle({ type: 'content.click', ref: 'zzz.1' });
    expect(result).toMatchObject({ ok: false, code: 'stale_ref' });
  });

  it('waits for content that appears later, and returns a usable ref', async () => {
    const pending = agent.handle({ type: 'content.wait', text: 'Results', timeoutMs: 1000 });
    setTimeout(() => {
      document.body.innerHTML = '<button>Results ready</button>';
    }, 10);
    const result = await pending;
    expect(result).toMatchObject({ ok: true });
    const ref = (result as { data: Item }).data.ref;
    expect(await agent.handle({ type: 'content.click', ref })).toMatchObject({ ok: true });
  });

  it('reports when the wait runs out', async () => {
    const result = await agent.handle({ type: 'content.wait', text: 'Never', timeoutMs: 20 });
    expect(result).toMatchObject({ ok: false, code: 'element_not_found' });
  });
});

describe('typing', () => {
  it('fills inputs in a way frameworks notice, and does not submit', async () => {
    document.body.innerHTML = '<form><input aria-label="Name" /><button>Save</button></form>';
    const input = document.querySelector('input') as HTMLInputElement;
    const events: string[] = [];
    input.addEventListener('input', () => events.push('input'));
    input.addEventListener('change', () => events.push('change'));
    const submit = vi.fn((event: Event) => event.preventDefault());
    document.querySelector('form')?.addEventListener('submit', submit);

    const result = await agent.handle({
      type: 'content.type',
      ref: await refOf('Name'),
      text: 'Ada',
    });
    expect(result.ok).toBe(true);
    expect(input.value).toBe('Ada');
    expect(events).toEqual(['input', 'change']);
    expect(submit).not.toHaveBeenCalled();
  });

  it('replaces existing text, and clears', async () => {
    document.body.innerHTML = '<textarea aria-label="Bio">old</textarea>';
    const ref = await refOf('Bio');
    await agent.handle({ type: 'content.type', ref, text: 'new' });
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('new');
    await agent.handle({ type: 'content.clear', ref });
    expect(textarea.value).toBe('');
  });

  it('refuses things that do not take text', async () => {
    document.body.innerHTML = '<button>Plain</button><input aria-label="RO" readonly />';
    expect(
      await agent.handle({ type: 'content.type', ref: await refOf('Plain'), text: 'x' }),
    ).toMatchObject({ code: 'not_editable' });
    expect(
      await agent.handle({ type: 'content.type', ref: await refOf('RO'), text: 'x' }),
    ).toMatchObject({ code: 'element_disabled' });
  });
});

describe('dropdowns', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <select aria-label="Size"><option value="s">Small</option><option value="l">Large</option></select>
    `;
  });

  it('chooses by label or value', async () => {
    const select = document.querySelector('select') as HTMLSelectElement;
    const changed = vi.fn();
    select.addEventListener('change', changed);
    const ref = await refOf('Size');
    expect(await agent.handle({ type: 'content.select', ref, option: 'large' })).toMatchObject({
      ok: true,
    });
    expect(select.value).toBe('l');
    expect(changed).toHaveBeenCalled();
    await agent.handle({ type: 'content.select', ref, option: 's' });
    expect(select.value).toBe('s');
  });

  it('reports a missing option and lists the choices', async () => {
    const result = await agent.handle({
      type: 'content.select',
      ref: await refOf('Size'),
      option: 'Huge',
    });
    expect(result).toMatchObject({ ok: false, code: 'option_not_found' });
    expect(result.ok === false && result.message).toContain('Small');
  });
});

describe('scrolling', () => {
  it('scrolls by direction and says when it could not move', async () => {
    const result = await agent.handle({ type: 'content.scroll', direction: 'down' });
    expect(window.scrollTo).toHaveBeenCalled();
    expect(result.ok && result.summary).toMatch(/could not scroll/i);
  });

  it('scrolls to a heading by its text', async () => {
    document.body.innerHTML = '<h2>Overview</h2><p>text</p><h2 id="h">History</h2>';
    const spy = vi.fn();
    (document.querySelector('#h') as HTMLElement).scrollIntoView = spy;
    const result = await agent.handle({ type: 'content.scroll', text: 'history' });
    expect(spy).toHaveBeenCalled();
    expect(result.ok && result.summary).toContain('History');
  });

  it('reports text that is not on the page', async () => {
    const result = await agent.handle({ type: 'content.scroll', text: 'Nowhere' });
    expect(result).toMatchObject({ ok: false, code: 'text_not_found' });
  });

  it('scrolls to an element reference', async () => {
    document.body.innerHTML = '<button>Far away</button>';
    const result = await agent.handle({ type: 'content.scroll', ref: await refOf('Far away') });
    expect(result.ok).toBe(true);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});

describe('keys', () => {
  it('runs a search with Enter', async () => {
    document.body.innerHTML = '<form role="search"><input name="q" aria-label="Search" /></form>';
    const submit = vi.fn((event: Event) => event.preventDefault());
    document.querySelector('form')?.addEventListener('submit', submit);
    await agent.handle({ type: 'content.press', key: 'Enter', ref: await refOf('Search') });
    expect(submit).toHaveBeenCalled();
  });

  it('respects a page that handles the key itself', async () => {
    document.body.innerHTML = '<form><input aria-label="Field" /></form>';
    const input = document.querySelector('input') as HTMLInputElement;
    input.addEventListener('keydown', (event) => event.preventDefault());
    const submit = vi.fn((event: Event) => event.preventDefault());
    document.querySelector('form')?.addEventListener('submit', submit);
    await agent.handle({ type: 'content.press', key: 'Enter', ref: await refOf('Field') });
    expect(submit).not.toHaveBeenCalled();
  });

  it('sends the key to the focused element when no ref is given', async () => {
    document.body.innerHTML = '<input aria-label="F" />';
    const input = document.querySelector('input') as HTMLInputElement;
    const pressed = vi.fn();
    input.addEventListener('keydown', pressed);
    input.focus();
    await agent.handle({ type: 'content.press', key: 'Escape' });
    expect(pressed).toHaveBeenCalled();
  });
});

describe('facts for the safety policy', () => {
  it('recognizes search forms, and does not treat login forms as searches', async () => {
    document.body.innerHTML = `
      <form role="search"><input name="q" aria-label="Find" /><button>Go</button></form>
      <form method="post"><input aria-label="User" /><input type="password" aria-label="Pw" /><button>Log in</button></form>
    `;
    const search = await describeRef(await refOf('Find'));
    expect(search.element).toMatchObject({ inForm: true, isSearchForm: true });

    const login = await describeRef(await refOf('Log in'));
    expect(login.element).toMatchObject({ isSubmit: true, inForm: true, isSearchForm: false });
  });

  it('identifies submit buttons, file inputs and links', async () => {
    document.body.innerHTML = `
      <form><input type="submit" value="Send it" /><input type="file" aria-label="CV" /></form>
      <a href="https://a.com/account/delete?x=1">Remove</a>
    `;
    expect((await describeRef(await refOf('Send it'))).element?.isSubmit).toBe(true);
    expect((await describeRef(await refOf('CV'))).element?.isFileInput).toBe(true);
    expect((await describeRef(await refOf('Remove'))).element?.href).toBe(
      'https://a.com/account/delete',
    );
  });

  it('detects security challenges, and hides them from the element list', async () => {
    document.body.innerHTML = `
      <div class="g-recaptcha"><button>Verify</button></div>
      <button>I'm not a robot</button>
      <button>Normal</button>
    `;
    expect((await list()).map((item) => item.name)).toEqual(['Normal']);
    const result = (await agent.handle({ type: 'content.describe' })) as ToolResult & {
      data: DescribeResult;
    };
    expect(result.data.page.hasChallenge).toBe(true);
  });

  it('reports the focused element for key presses', async () => {
    document.body.innerHTML = '<button id="x">Delete</button>';
    (document.querySelector('#x') as HTMLElement).focus();
    const result = (await agent.handle({ type: 'content.describe' })) as ToolResult & {
      data: DescribeResult;
    };
    expect(result.data.element?.name).toBe('Delete');
  });
});
