import { describe, expect, it } from 'vitest';
import { parseCount, parseSimpleInstruction, siteSearchUrl } from './intent.js';

const parse = parseSimpleInstruction;

describe('instructions simple enough to need no AI', () => {
  it.each([
    'Open a new tab and go to YouTube.',
    'open a new tab and open youtube',
    'Open a new tab and navigate to YouTube',
    'please open a new tab, then go to you tube',
    'Dopilot, open a new tab and navigate to YouTube.',
  ])('understands "%s"', (text) => {
    expect(parse(text)).toEqual([
      { kind: 'new_tab' },
      expect.objectContaining({ kind: 'open', url: 'https://www.youtube.com/', site: 'youtube' }),
    ]);
  });

  it('opens in a new tab for "open", and in this tab for "go to"', () => {
    expect(parse('open github')?.[0]).toMatchObject({ kind: 'open', newTab: true });
    expect(parse('go to github')?.[0]).toMatchObject({ kind: 'open', newTab: false });
    expect(parse('open github in this tab')?.[0]).toMatchObject({ kind: 'open', newTab: false });
    expect(parse('go to github in a new tab')?.[0]).toMatchObject({ kind: 'open', newTab: true });
  });

  it('accepts addresses, and refuses unsafe ones', () => {
    expect(parse('go to example.com/docs')?.[0]).toMatchObject({ url: 'https://example.com/docs' });
    expect(parse('go to javascript:alert(1)')).toBeNull();
    expect(parse('open chrome://settings')).toBeNull();
    expect(parse('go to file:///etc/passwd')).toBeNull();
  });

  it('understands the multi-step workflow from start to finish', () => {
    expect(
      parse(
        'Open Wikipedia, search for artificial intelligence, and scroll to the history section.',
      ),
    ).toEqual([
      expect.objectContaining({ kind: 'open', site: 'wikipedia' }),
      { kind: 'search', site: null, query: 'artificial intelligence' },
      { kind: 'scroll_text', text: 'history' },
    ]);
  });

  it('understands tab references', () => {
    expect(parse('Switch to GitHub, then return to the previous tab.')).toEqual([
      { kind: 'switch_named', name: 'GitHub' },
      { kind: 'switch_previous' },
    ]);
    expect(parse('switch to tab 3')).toEqual([{ kind: 'switch_position', position: 3 }]);
    expect(parse('go back to the previous tab')).toEqual([{ kind: 'switch_previous' }]);
    expect(parse('go to the github tab')).toEqual([{ kind: 'switch_named', name: 'github' }]);
  });

  it('keeps "go back" apart from "go back to the previous tab"', () => {
    expect(parse('go back')).toEqual([{ kind: 'back' }]);
  });

  it('understands simple page controls', () => {
    expect(parse('scroll down')).toEqual([{ kind: 'scroll_direction', direction: 'down' }]);
    expect(parse('scroll to the bottom')).toEqual([
      { kind: 'scroll_direction', direction: 'bottom' },
    ]);
    expect(parse('reload this page')).toEqual([{ kind: 'reload' }]);
    expect(parse('close this tab')).toEqual([{ kind: 'close' }]);
  });

  it('keeps capitals, because addresses and searches can depend on them', () => {
    expect(parse('Go to developer.mozilla.org/en-US/docs/Web/API')?.[0]).toMatchObject({
      url: 'https://developer.mozilla.org/en-US/docs/Web/API',
    });
    expect(parse('search youtube for The Beatles')?.[0]).toMatchObject({ query: 'The Beatles' });
    expect(parse('OPEN YOUTUBE')?.[0]).toMatchObject({ site: 'youtube' });
  });

  it('builds search addresses, encoded', () => {
    expect(siteSearchUrl('youtube', 'lo fi & beats')).toBe(
      'https://www.youtube.com/results?search_query=lo%20fi%20%26%20beats',
    );
    expect(siteSearchUrl('gmail', 'x')).toBeNull();
  });

  // Getting one of these wrong would do something nobody asked for, so each goes to the AI.
  it.each([
    'click the blue button',
    'find the blue button on this test page and click it',
    'open youtube and play some music',
    'what is on my screen',
    'open the first result',
    'open that link',
    'open the wiki',
    'go to the settings',
    'summarize this page',
    'delete my account',
    'search for rock and roll',
    'open youtube, go to wikipedia, go to github, go to reddit, go to mdn, go to google',
    'send an email to my boss',
    'open',
    '',
  ])('leaves "%s" to the AI', (text) => {
    expect(parse(text)).toBeNull();
  });
});

describe('batches of tabs', () => {
  it.each([
    ['Open 10 new tabs.', 10],
    ['open ten new tabs', 10],
    ['Create 5 blank tabs.', 5],
    ['create five empty tabs', 5],
    ['Please open twenty tabs', 20],
    ['open twenty-one tabs', 21],
    ['make a dozen new tabs', 12],
    ['open a couple of tabs', 2],
    ['Open 3 more tabs', 3],
    ['open 0 tabs', 0],
    ['open 500 new tabs', 500],
    ['open a thousand tabs', 1000],
  ])('counts "%s" as %i', (text, count) => {
    expect(parse(text)).toEqual([{ kind: 'new_tabs', count }]);
  });

  it('treats one tab as the ordinary single tab', () => {
    expect(parse('open 1 new tab')).toEqual([{ kind: 'new_tab' }]);
    expect(parse('open one new tab')).toEqual([{ kind: 'new_tab' }]);
    expect(parse('open a new tab')).toEqual([{ kind: 'new_tab' }]);
  });

  it.each([
    'Open YouTube, GitHub, and Wikipedia in separate tabs.',
    'open youtube, github and wikipedia in different tabs',
    'open tabs for YouTube, GitHub, Wikipedia',
    'Open YouTube, GitHub and Wikipedia each in a new tab',
  ])('opens a list from "%s"', (text) => {
    expect(parse(text)).toEqual([
      {
        kind: 'open_many',
        urls: ['https://www.youtube.com/', 'https://github.com/', 'https://www.wikipedia.org/'],
      },
    ]);
  });

  it('accepts addresses in a list, and leaves any uncertain one to the AI', () => {
    expect(parse('open a.com and b.com in separate tabs')?.[0]).toMatchObject({
      urls: ['https://a.com/', 'https://b.com/'],
    });
    expect(parse('open youtube and my bank in separate tabs')).toBeNull();
    expect(parse('open javascript:alert(1) and github in separate tabs')).toBeNull();
  });

  it.each([
    'Open 3 tabs and navigate each to Google.',
    'open three tabs, then go to google in each',
  ])('sends each tab somewhere for "%s"', (text) => {
    expect(parse(text)).toEqual([
      { kind: 'new_tabs', count: 3 },
      { kind: 'open_each', url: 'https://www.google.com/' },
    ]);
  });

  it.each([
    ['Create 10 tabs and switch to the last one.', 'last'],
    ['create ten tabs and switch to the last tab', 'last'],
    ['open 5 tabs, then go to the third one', 3],
    ['open 5 tabs and switch to the 2nd tab', 2],
    ['open 5 tabs and switch to the first one', 1],
  ])('switches within the batch for "%s"', (text, which) => {
    expect(parse(text)?.[1]).toEqual({ kind: 'switch_created', which });
  });

  it('keeps ordinary meanings outside a batch', () => {
    expect(parse('switch to the last tab')).toEqual([{ kind: 'switch_previous' }]);
    expect(parse('open 5 tabs and switch to tab 2')?.[1]).toEqual({
      kind: 'switch_position',
      position: 2,
    });
    expect(parse('switch to the third one')).toEqual([{ kind: 'switch_named', name: 'third one' }]);
    expect(parse('navigate each to google')).toBeNull();
  });

  it.each([
    'open some tabs',
    'open a few tabs',
    'open many new tabs',
    'open -3 tabs',
    'open 2.5 tabs',
    'open ten tabs and read them',
  ])('leaves "%s" to the AI', (text) => {
    expect(parse(text)).toBeNull();
  });
});

describe('parseCount', () => {
  it.each([
    ['7', 7],
    ['seven', 7],
    ['Twenty', 20],
    ['twenty five', 25],
    ['twenty-five', 25],
    ['ninety nine', 99],
    ['a hundred', 100],
    ['a million', 1000000],
  ])('reads %s', (text, value) => {
    expect(parseCount(text)).toBe(value);
  });

  it.each(['', 'ten ten', 'twenty ten', 'lots', 'a few', 'ten thousand tabs'])(
    'does not guess at "%s"',
    (text) => {
      expect(parseCount(text)).toBeNull();
    },
  );
});
