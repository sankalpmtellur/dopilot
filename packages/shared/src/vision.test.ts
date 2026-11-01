import { describe, expect, it } from 'vitest';
import {
  checkScreenshotFresh,
  imagePointToViewport,
  looksSensitive,
  MAX_SCREENSHOT_AGE_MS,
  rankVisionModels,
  validateImageDataUrl,
  viewportBoxToImage,
} from './vision.js';
import type { ScreenshotRecord, ViewportState } from './vision.js';

const viewport: ViewportState = {
  url: 'https://a.com/page',
  title: 'A',
  width: 1600,
  height: 900,
  scrollX: 0,
  scrollY: 100,
  dpr: 2,
  fingerprint: 'abc',
};
const shot: ScreenshotRecord = {
  id: 's1',
  tabId: 1,
  capturedAt: 1000,
  viewport,
  imageWidth: 1280,
  imageHeight: 720,
};

describe('checkScreenshotFresh', () => {
  const check = (changes: Partial<ViewportState> = {}, tabId = 1, now = 2000) =>
    checkScreenshotFresh(shot, tabId, { ...viewport, ...changes }, now);

  it('accepts an unchanged page, and ignores tiny scroll differences', () => {
    expect(check()).toBeNull();
    expect(check({ scrollY: 101 })).toBeNull();
  });

  it.each([
    ['another tab', {}, 2, 2000, /different tab/],
    ['a navigation', { url: 'https://a.com/other' }, 1, 2000, /navigated/],
    ['a resize', { width: 1200 }, 1, 2000, /size/],
    ['a scroll', { scrollY: 500 }, 1, 2000, /scrolled/],
    ['changed controls', { fingerprint: 'zzz' }, 1, 2000, /changed/],
    ['age', {}, 1, 1000 + MAX_SCREENSHOT_AGE_MS + 1, /too old/],
  ])('rejects %s', (_label, changes, tabId, now, reason) => {
    expect(check(changes, tabId, now)).toMatch(reason);
  });
});

describe('coordinate scaling', () => {
  it('maps image pixels to page coordinates', () => {
    expect(imagePointToViewport({ x: 640, y: 360 }, shot)).toEqual({ x: 800, y: 450 });
    expect(imagePointToViewport({ x: 0, y: 0 }, shot)).toEqual({ x: 0, y: 0 });
  });

  it('does not depend on device pixel ratio', () => {
    const retina = { ...shot, viewport: { ...viewport, dpr: 3 } };
    expect(imagePointToViewport({ x: 640, y: 360 }, retina)).toEqual({ x: 800, y: 450 });
  });

  it('refuses points outside the image', () => {
    for (const point of [
      { x: -1, y: 10 },
      { x: 10, y: -1 },
      { x: 1280, y: 10 },
      { x: 10, y: 720 },
      { x: Number.NaN, y: 10 },
    ]) {
      expect(imagePointToViewport(point, shot)).toBeNull();
    }
  });

  it('maps page boxes onto the image', () => {
    expect(viewportBoxToImage([100, 200, 300, 400], { x: 0.8, y: 0.8 })[2]).toBeCloseTo(240);
  });
});

describe('validateImageDataUrl', () => {
  it('accepts real image data', () => {
    expect(validateImageDataUrl('data:image/jpeg;base64,/9j/4AAQSkZJRg==')).toBeNull();
    expect(validateImageDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBeNull();
  });

  it.each([
    ['nothing', undefined],
    ['plain text', 'hello'],
    ['HTML', 'data:text/html;base64,PGh0bWw+'],
    ['SVG, which can carry scripts', 'data:image/svg+xml;base64,PHN2Zz4='],
    ['a mismatched type', 'data:image/jpeg;base64,iVBORw0KGgo='],
    ['a remote address', 'https://evil.example/a.jpg'],
    ['oversized data', `data:image/jpeg;base64,/9j/${'A'.repeat(5_000_000)}`],
  ])('rejects %s', (_label, value) => {
    expect(validateImageDataUrl(value)).not.toBeNull();
  });
});

describe('rankVisionModels', () => {
  it('prefers known vision models and does not guess at others', () => {
    const ranked = rankVisionModels([
      { id: 'llama-3.3-70b-versatile' },
      { id: 'whisper-large-v3' },
      { id: 'meta-llama/llama-4-maverick' },
      { id: 'qwen/qwen3.8-27b' },
    ]);
    expect(ranked.map((model) => model.id)).toEqual([
      'qwen/qwen3.8-27b',
      'meta-llama/llama-4-maverick',
    ]);
  });
});

describe('looksSensitive', () => {
  it('flags payment and banking pages', () => {
    expect(looksSensitive({ url: 'https://shop.com/checkout', title: 'Cart' })).toBe(true);
    expect(looksSensitive({ url: 'https://a.com', title: 'My Bank' })).toBe(true);
    expect(looksSensitive({ url: 'https://wikipedia.org', title: 'Cats' })).toBe(false);
  });
});
