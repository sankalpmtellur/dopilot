import { describe, expect, it } from 'vitest';
import { parseSimpleInstruction, siteSearchUrl } from './intent.js';

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
