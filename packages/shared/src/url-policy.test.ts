import { describe, expect, it } from 'vitest';
import {
  isRestrictedTabUrl,
  sanitizeTabTitle,
  sanitizeTabUrl,
  validateNavigationUrl,
} from './url-policy.js';

describe('validateNavigationUrl', () => {
  it.each([
    ['https://youtube.com', 'https://youtube.com/'],
    ['http://example.com/a?b=1', 'http://example.com/a?b=1'],
    ['youtube.com', 'https://youtube.com/'],
    ['example.com:8080/x', 'https://example.com:8080/x'],
    ['localhost:3000', 'http://localhost:3000/'],
    ['HTTPS://Example.COM', 'https://example.com/'],
    ['  https://example.com  ', 'https://example.com/'],
  ])('allows %s', (input, url) => {
    expect(validateNavigationUrl(input)).toEqual({ ok: true, url });
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\nscript:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'chrome://settings',
    'brave://settings',
    'chrome-extension://abc/settings/index.html',
    'about:config',
    'view-source:https://example.com',
    'blob:https://example.com/1',
    'filesystem:https://example.com/x',
    'ftp://example.com',
    'edge://settings',
    'https://user:pass@example.com',
    'https://example.com@evil.example',
    'https:\\\\example.com',
    'not a url',
    'youtube',
    '',
    `https://example.com/${'a'.repeat(3000)}`,
  ])('blocks %s', (input) => {
    expect(validateNavigationUrl(input).ok).toBe(false);
  });
});

describe('isRestrictedTabUrl', () => {
  it('restricts internal and extension pages', () => {
    for (const url of ['chrome://settings/', 'brave://wallet/', 'chrome-extension://a/b.html']) {
      expect(isRestrictedTabUrl(url)).toBe(true);
    }
  });

  it('does not restrict web pages or blank new tabs', () => {
    for (const url of ['https://a.com/', 'http://a.com/', 'chrome://newtab/', 'brave://newtab/']) {
      expect(isRestrictedTabUrl(url)).toBe(false);
    }
  });
});

describe('sanitizeTabUrl', () => {
  it('removes credentials, query strings and fragments', () => {
    expect(sanitizeTabUrl('https://user:pw@a.com/path?token=secret#frag')).toBe(
      'https://a.com/path',
    );
  });

  it('hides internal page addresses', () => {
    expect(sanitizeTabUrl('chrome://settings/passwords')).toBeUndefined();
  });
});

describe('sanitizeTabTitle', () => {
  const url = 'https://a.com/x?token=secret#frag';

  it('removes the query string from a title made from the address', () => {
    expect(sanitizeTabTitle('a.com/x?token=secret#frag', url)).toBe('a.com/x');
  });

  it('leaves ordinary titles alone', () => {
    expect(sanitizeTabTitle('Inbox (3)', url)).toBe('Inbox (3)');
    expect(sanitizeTabTitle('Inbox', undefined)).toBe('Inbox');
  });
});

describe('addresses on this machine', () => {
  it('use http when no scheme was given, like localhost', () => {
    expect(validateNavigationUrl('127.0.0.1:3000/x')).toEqual({
      ok: true,
      url: 'http://127.0.0.1:3000/x',
    });
    expect(validateNavigationUrl('localhost:3000')).toEqual({
      ok: true,
      url: 'http://localhost:3000/',
    });
    expect(validateNavigationUrl('192.168.1.1')).toEqual({ ok: true, url: 'https://192.168.1.1/' });
  });
});
