import { describe, expect, it } from 'vitest';
import { isExtensionPage } from './sender';

const id = 'abc';

describe('isExtensionPage', () => {
  it('accepts the extension’s own pages', () => {
    expect(isExtensionPage({ id, origin: `chrome-extension://${id}` }, id)).toBe(true);
  });

  it('rejects content scripts, which run with the origin of a webpage', () => {
    expect(isExtensionPage({ id, origin: 'https://evil.example' }, id)).toBe(false);
  });

  it('rejects other extensions', () => {
    expect(isExtensionPage({ id: 'other', origin: 'chrome-extension://other' }, id)).toBe(false);
  });
});
