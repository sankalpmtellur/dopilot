import { ModelError } from '@dopilot/agent-core';
import type { ModelRequest, ToolContext } from '@dopilot/agent-core';
import type {
  ContentRequest,
  GroqStatus,
  ToolResult,
  ViewportState,
  VisualSnapshot,
} from '@dopilot/shared';
import { DEFAULT_PREFERENCES, SCREENSHOT_REUSE_MS } from '@dopilot/shared';
import type { Preferences } from '@dopilot/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserApi } from './browser-commands';
import { createToolService } from './tool-service';
import { CaptureAccessError, createVisionService } from './vision-service';

const IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

const viewport: ViewportState = {
  url: 'https://a.com/page',
  title: 'Page',
  width: 1600,
  height: 900,
  scrollX: 0,
  scrollY: 0,
  dpr: 2,
  fingerprint: 'fp',
};

let snapshot: VisualSnapshot;
let tab: Partial<chrome.tabs.Tab>;
let time: number;
let replies: (string | ModelError | null)[];
let requests: ModelRequest[];
let status: GroqStatus;
let capture: ReturnType<typeof vi.fn>;
let content: { send: ReturnType<typeof vi.fn>; canAccess: ReturnType<typeof vi.fn> };
let image: { process: ReturnType<typeof vi.fn>; annotate: ReturnType<typeof vi.fn> };
let preferences: Preferences = { ...DEFAULT_PREFERENCES };
let grounded: unknown;
let describeFacts: unknown;
let vision: ReturnType<typeof createVisionService>;
let service: ReturnType<typeof createToolService>;

const context: ToolContext = {
  runId: 'run-1',
  source: 'panel',
  currentTabId: 1,
  signal: new AbortController().signal,
};

function facts(name: string, extra: object = {}) {
  return {
    element: {
      tag: 'canvas',
      role: 'canvas',
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
    },
    page: { url: viewport.url, title: 'Page', headings: [], hasChallenge: false },
  };
}

beforeEach(() => {
  time = 1000;
  replies = [];
  requests = [];
  preferences = { ...DEFAULT_PREFERENCES };
  tab = { id: 1, windowId: 5, active: true, url: 'https://a.com/page?token=x', status: 'complete' };
  snapshot = {
    viewport,
    hasChallenge: false,
    elements: [
      { ref: 'ab.1', role: 'button', name: 'Save', box: [10, 10, 50, 20] },
      { ref: 'ab.2', role: 'button', name: '', box: [100, 100, 40, 40], color: 'blue' },
    ],
    secretBoxes: [[0, 0, 100, 20]],
    frameCount: 0,
  };
  status = {
    configured: true,
    maskedKey: 'x',
    connection: { state: 'connected', checkedAt: 1 },
    models: [],
    selectedModel: null,
    visionModels: [{ id: 'qwen/qwen3.8-27b' }],
    selectedVisionModel: null,
    visionFallback: 'fallback-vision',
    speechModels: [],
  };
  capture = vi.fn(async () => IMAGE);
  grounded = { kind: 'element', ref: 'ab.9', interactive: false };
  describeFacts = facts('');
  content = {
    canAccess: vi.fn(async () => true),
    send: vi.fn(async (_tabId: number, request: ContentRequest): Promise<ToolResult> => {
      switch (request.type) {
        case 'content.visual_snapshot':
          return { ok: true, summary: 's', data: snapshot };
        case 'content.viewport':
          return { ok: true, summary: 'v', data: snapshot.viewport };
        case 'content.ground_point':
          return { ok: true, summary: 'g', data: grounded };
        case 'content.describe':
          return { ok: true, summary: 'd', data: describeFacts };
        default:
          return { ok: true, summary: `${request.type} done` };
      }
    }),
  };
  image = {
    process: vi.fn(async () => ({ dataUrl: IMAGE, width: 1280, height: 720 })),
    annotate: vi.fn(async () => IMAGE),
  };
  const api = {
    getTab: vi.fn(async () => tab),
    queryTabs: vi.fn(async () => [tab]),
  } as unknown as BrowserApi;
  vision = createVisionService({
    api,
    content: content as never,
    capture: capture as never,
    image: image as never,
    loadPreferences: async () => preferences,
    loadGroqStatus: async () => status,
    model: async () => ({
      complete: async (request) => {
        requests.push(request);
        const next = replies.shift();
        if (next instanceof ModelError) throw next;
        return { text: next ?? null, toolCalls: [] };
      },
    }),
    now: () => time,
    sleep: async () => undefined,
  });
  service = createToolService({
    api,
    content: content as never,
    vision,
    sleep: async () => undefined,
    permissions: {
      hasTabDetails: async () => true,
      hasOrigin: async () => true,
      hasAllUrls: async () => false,
    },
  });
});

const assess = (name: string, args: Record<string, unknown> = {}, ctx = context) =>
  service.toolbox.assess(name, args, ctx);
const run = (name: string, args: Record<string, unknown> = {}, ctx = context) =>
  service.toolbox.execute(name, args, ctx);

describe('screenshot authorization', () => {
  it('asks for site access before anything is captured', async () => {
    const restricted = createToolService({
      api: { getTab: async () => tab, queryTabs: async () => [tab] } as unknown as BrowserApi,
      content: { send: content.send as never, canAccess: async () => false },
      vision,
      permissions: {
        hasTabDetails: async () => true,
        hasOrigin: async () => false,
        hasAllUrls: async () => false,
      },
    });
    expect(await restricted.toolbox.assess('capture_visible_tab', {}, context)).toMatchObject({
      kind: 'site_access',
      origin: 'https://a.com',
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it('asks for screenshot access when the browser refuses, and sends nothing', async () => {
    capture.mockRejectedValue(new CaptureAccessError());
    expect(await assess('analyze_screenshot', { question: 'q' })).toMatchObject({
      decision: 'approve',
      kind: 'screenshot_access',
    });
    expect(requests).toHaveLength(0);
  });

  it('never captures private windows, internal pages or background tabs', async () => {
    for (const [changes, code] of [
      [{ incognito: true }, 'private_tab'],
      [{ url: 'chrome://settings/' }, 'restricted_page'],
      [{ url: 'chrome-extension://abc/x.html' }, 'restricted_page'],
      [{ active: false }, 'tab_not_visible'],
    ] as const) {
      tab = { id: 1, windowId: 5, active: true, url: 'https://a.com/', ...changes };
      const result = await assess('capture_visible_tab');
      expect(JSON.stringify(result)).toMatch(new RegExp(code + '|restricted_page'));
      expect(result.decision).toBe('block');
    }
    expect(capture).not.toHaveBeenCalled();
  });

  it('respects vision being turned off', async () => {
    preferences = { ...preferences, vision: false };
    expect(await assess('analyze_screenshot', { question: 'q' })).toMatchObject({
      decision: 'block',
      result: { code: 'vision_off' },
    });
  });

  it('stops at a CAPTCHA, and never sends it for analysis', async () => {
    snapshot = { ...snapshot, hasChallenge: true };
    expect(await assess('analyze_screenshot', { question: 'solve this' })).toMatchObject({
      result: { code: 'security_challenge', stopTask: true },
    });
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('consent before sending', () => {
  it('asks first, says who processes it, and offers a preview', async () => {
    const result = (await assess('analyze_screenshot', { question: 'q' })) as Extract<
      Awaited<ReturnType<typeof assess>>,
      { decision: 'approve' }
    >;
    expect(result).toMatchObject({ decision: 'approve', kind: 'screenshot' });
    expect(result.title).toContain('a.com');
    expect(result.detail).toMatch(/Groq/);
    expect(result.screenshotId).toBeTruthy();
    expect(vision.getImage(result.screenshotId as string)).toBe(IMAGE);
    expect(requests).toHaveLength(0);
  });

  it('capturing alone sends nothing and needs no consent', async () => {
    expect((await assess('capture_visible_tab')).decision).toBe('allow');
    const result = await run('capture_visible_tab');
    expect(result).toMatchObject({ ok: true, data: { width: 1280, height: 720 } });
    expect(JSON.stringify(result)).not.toContain('base64');
    expect(requests).toHaveLength(0);
  });

  it('remembers agreement for the site during one task only', async () => {
    replies = ['An answer'];
    await run('analyze_screenshot', { question: 'q' });
    expect((await assess('analyze_screenshot', { question: 'next' })).decision).toBe('allow');
    expect(
      (await assess('analyze_screenshot', { question: 'q' }, { ...context, runId: 'run-2' }))
        .decision,
    ).toBe('approve');
  });

  it('asks every time on payment pages, and warns', async () => {
    snapshot = { ...snapshot, viewport: { ...viewport, url: 'https://a.com/checkout' } };
    replies = ['An answer'];
    await run('analyze_screenshot', { question: 'q' });
    const result = await assess('analyze_screenshot', { question: 'q2' });
    expect(result).toMatchObject({ decision: 'approve' });
    expect(JSON.stringify(result)).toMatch(/payment/);
  });

  it('cannot be skipped through MCP', async () => {
    expect(await service.runExternalCall('analyze_screenshot', { question: 'q' })).toMatchObject({
      code: 'approval_required',
    });
    expect(requests).toHaveLength(0);
  });

  it('never exposes the image through MCP or tool results', async () => {
    const result = await service.runExternalCall('capture_visible_tab', {});
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('base64');
  });
});

describe('processing images', () => {
  it('rejects a capture that is not a valid image', async () => {
    capture.mockResolvedValue('data:text/html;base64,PGh0bWw+');
    expect(await assess('capture_visible_tab')).toMatchObject({
      result: { code: 'invalid_image' },
    });
    expect(image.process).not.toHaveBeenCalled();
  });

  it('paints over secret fields before anything else sees the image', async () => {
    await assess('capture_visible_tab');
    expect(image.process.mock.calls[0]?.[1]).toMatchObject({
      viewportWidth: 1600,
      viewportHeight: 900,
      masks: [[0, 0, 100, 20]],
    });
  });

  it('reuses a recent capture of an unchanged page', async () => {
    await assess('capture_visible_tab');
    await assess('capture_visible_tab');
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('captures again when the page changed or the capture is old', async () => {
    await assess('capture_visible_tab');
    snapshot = { ...snapshot, viewport: { ...viewport, fingerprint: 'changed' } };
    await assess('capture_visible_tab');
    expect(capture).toHaveBeenCalledTimes(2);
    time += 20_000;
    await assess('capture_visible_tab');
    expect(capture).toHaveBeenCalledTimes(3);
  });

  it('forgets screenshots when the task ends', async () => {
    const first = (await assess('analyze_screenshot', { question: 'q' })) as {
      screenshotId: string;
    };
    vision.clear();
    expect(vision.getImage(first.screenshotId)).toBeNull();
  });
});

describe('vision requests', () => {
  it('sends a real multimodal request, without tools, to a discovered model', async () => {
    replies = ['A chart of sales.'];
    const result = await run('analyze_screenshot', { question: 'What does the chart show?' });

    expect(result).toMatchObject({ ok: true, untrusted: true });
    expect(JSON.stringify(result)).toContain('A chart of sales.');
    const request = requests[0] as ModelRequest;
    expect(request.model).toBe('qwen/qwen3.8-27b');
    expect(request.tools).toEqual([]);
    const content = request.messages.at(-1)?.content as {
      type: string;
      dataUrl?: string;
      text?: string;
    }[];
    expect(content[0]?.text).toContain('What does the chart show?');
    expect(content[1]).toEqual({ type: 'image', dataUrl: IMAGE });
    expect(request.messages[0]?.content).toMatch(/untrusted/);
  });

  it('never claims to have seen an image without an actual answer', async () => {
    replies = [null];
    const result = await run('analyze_screenshot', { question: 'q' });
    expect(result).toMatchObject({ ok: false, code: 'vision_no_answer' });
  });

  it('does not repeat the same question about the same screenshot', async () => {
    replies = ['Answer.'];
    await run('analyze_screenshot', { question: 'q' });
    await run('analyze_screenshot', { question: 'q' });
    expect(requests).toHaveLength(1);
  });

  it('uses the selected model first', async () => {
    status = { ...status, selectedVisionModel: 'my-choice' };
    replies = ['Answer.'];
    await run('analyze_screenshot', { question: 'q' });
    expect(requests[0]?.model).toBe('my-choice');
  });

  it('falls back through models, ending at the configured one', async () => {
    replies = [new ModelError('model_unavailable', 'Gone.'), 'From the fallback.'];
    const result = await run('analyze_screenshot', { question: 'q' });
    expect(requests.map((request) => request.model)).toEqual([
      'qwen/qwen3.8-27b',
      'fallback-vision',
    ]);
    expect(JSON.stringify(result)).toContain('From the fallback.');
  });

  it('works when no vision model was discovered', async () => {
    status = { ...status, visionModels: [] };
    replies = ['Answer.'];
    await run('analyze_screenshot', { question: 'q' });
    expect(requests[0]?.model).toBe('fallback-vision');
  });

  it('is honest when no vision model is left', async () => {
    replies = [
      new ModelError('model_unavailable', 'Gone.'),
      new ModelError('model_unavailable', 'Gone.'),
    ];
    expect(await run('analyze_screenshot', { question: 'q' })).toMatchObject({
      ok: false,
      code: 'vision_model_unavailable',
    });
  });

  it('retries once with a smaller image when one is refused', async () => {
    replies = [new ModelError('image_rejected', 'Too big.'), 'Answer.'];
    expect((await run('analyze_screenshot', { question: 'q' })).ok).toBe(true);
    expect(image.process.mock.lastCall?.[1]).toMatchObject({ maxEdge: 768 });

    replies = [new ModelError('image_rejected', 'No.'), new ModelError('image_rejected', 'No.')];
    expect(await run('analyze_screenshot', { question: 'other' })).toMatchObject({
      code: 'image_rejected',
    });
  });

  it('explains free-tier rate limits and does not hammer Groq', async () => {
    replies = [new ModelError('rate_limited', 'Try again in 30s.', 30)];
    const result = await run('analyze_screenshot', { question: 'q' });
    expect(result).toMatchObject({ ok: false, code: 'vision_rate_limited' });
    expect(result.ok === false && result.message).toMatch(/free-tier.*30s/);
    expect(requests).toHaveLength(1);
  });

  it('reports cancellation rather than an answer', async () => {
    replies = [new ModelError('cancelled', 'Cancelled.')];
    expect(await run('analyze_screenshot', { question: 'q' })).toMatchObject({ code: 'cancelled' });
  });
});

describe('grounding visual targets', () => {
  async function findPoint(reply: object) {
    replies = [JSON.stringify(reply)];
    const result = await run('get_visual_page_context', { question: 'the thing' });
    return result as Extract<ToolResult, { ok: true }> & {
      data: {
        screenshotId: string;
        targets: { ref: string }[];
        points: { pointId: string }[];
        note?: string;
      };
    };
  }
  const point = { description: 'd', targets: [], points: [{ x: 640, y: 360, why: 'canvas' }] };

  it('shows the model real elements, and returns real refs', async () => {
    const result = await findPoint({
      description: 'A blue icon',
      targets: [{ n: 2, why: 'blue' }],
    });
    expect(result.data.targets).toEqual([{ ref: 'ab.2', role: 'button', name: '', why: 'blue' }]);
    expect(image.annotate.mock.calls[0]?.[1]).toHaveLength(2);
    const text = (requests[0]?.messages.at(-1)?.content as { text?: string }[])[0]?.text;
    expect(text).toContain('(no label), blue');
  });

  it('marks elements in image pixels, not page pixels', async () => {
    await findPoint({ description: 'd', targets: [] });
    const box = image.annotate.mock.calls[0]?.[1][1].box;
    expect(box[0]).toBeCloseTo(80);
    expect(box[2]).toBeCloseTo(32);
  });

  it('ignores targets that do not exist, and points outside the image', async () => {
    const result = await findPoint({
      description: 'd',
      targets: [{ n: 99 }, { n: 'x' }, { ref: 'ab.1' }],
      points: [
        { x: 5000, y: 10 },
        { x: 'a', y: 1 },
      ],
    });
    expect(result.data.targets).toEqual([]);
    expect(result.data.points).toEqual([]);
    expect(result.summary).toMatch(/Nothing was guessed/);
  });

  it('survives a reply that is not JSON, and invents no targets', async () => {
    replies = ['I can see a page with some buttons.'];
    const result = await run('get_visual_page_context', { question: 'x' });
    expect(result).toMatchObject({ ok: true, data: { targets: [], points: [] } });
  });

  it('is honest about frames', async () => {
    snapshot = { ...snapshot, frameCount: 2 };
    const result = await findPoint({ description: 'd' });
    expect(result.data.note).toMatch(/2 embedded/);
  });

  it('scales the point to page coordinates, and clicks at the real position', async () => {
    const { data } = await findPoint(point);
    const args = { screenshotId: data.screenshotId, pointId: 'p1' };
    expect((await assess('click_visual_target', args)).decision).toBe('allow');
    await run('click_visual_target', args);

    const calls = content.send.mock.calls.map((call) => call[1]);
    expect(calls).toContainEqual({ type: 'content.ground_point', x: 800, y: 450 });
    expect(calls).toContainEqual({ type: 'content.click_point', ref: 'ab.9', x: 800, y: 450 });
  });

  it('prefers a real element over coordinates when one is there', async () => {
    const { data } = await findPoint(point);
    grounded = { kind: 'element', ref: 'ab.7', interactive: true };
    await run('click_visual_target', { screenshotId: data.screenshotId, pointId: 'p1' });
    const calls = content.send.mock.calls.map((call) => call[1]);
    expect(calls).toContainEqual({ type: 'content.click', ref: 'ab.7' });
    expect(calls.some((call) => call.type === 'content.click_point')).toBe(false);
  });

  it('refuses points the vision model never reported', async () => {
    const { data } = await findPoint(point);
    expect(
      await assess('click_visual_target', { screenshotId: data.screenshotId, pointId: 'p9' }),
    ).toMatchObject({ result: { code: 'unknown_point' } });
  });

  it.each([
    ['scrolled', { scrollY: 400 }],
    ['navigated', { url: 'https://a.com/other' }],
    ['changed', { fingerprint: 'new' }],
    ['resized', { width: 1000 }],
  ])('aborts if the page %s, before and after approval', async (_label, changes) => {
    const { data } = await findPoint(point);
    snapshot = { ...snapshot, viewport: { ...viewport, ...changes } };
    const args = { screenshotId: data.screenshotId, pointId: 'p1' };

    expect(await assess('click_visual_target', args)).toMatchObject({
      result: { code: 'stale_screenshot' },
    });
    expect(await run('click_visual_target', args)).toMatchObject({ code: 'stale_screenshot' });
    const clicks = content.send.mock.calls.filter((call) => /click/.test(call[1].type));
    expect(clicks).toHaveLength(0);
  });

  it('aborts if the screenshot is too old', async () => {
    const { data } = await findPoint(point);
    time += 120_000;
    expect(
      await assess('click_visual_target', { screenshotId: data.screenshotId, pointId: 'p1' }),
    ).toMatchObject({ result: { code: 'stale_screenshot' } });
  });

  it('aborts if a different tab is now current', async () => {
    const { data } = await findPoint(point);
    const other = { ...context, currentTabId: 2 };
    const api = await assess(
      'click_visual_target',
      { screenshotId: data.screenshotId, pointId: 'p1' },
      other,
    );
    expect(api).toMatchObject({ result: { code: 'stale_screenshot' } });
  });

  it('is honest about frames it cannot reach', async () => {
    const { data } = await findPoint(point);
    grounded = { kind: 'frame' };
    expect(
      await assess('click_visual_target', { screenshotId: data.screenshotId, pointId: 'p1' }),
    ).toMatchObject({ result: { code: 'inside_frame', recoverable: false } });
  });

  it('needs approval when what is really there is sensitive', async () => {
    const { data } = await findPoint(point);
    describeFacts = facts('Delete account');
    const result = await assess('click_visual_target', {
      screenshotId: data.screenshotId,
      pointId: 'p1',
    });
    expect(result).toMatchObject({ decision: 'approve', title: 'Click “Delete account”?' });
    expect(content.send.mock.calls.some((call) => /click/.test(call[1].type))).toBe(false);
  });

  it('cannot submit a graded quiz by clicking where a button appears', async () => {
    const { data } = await findPoint(point);
    describeFacts = {
      ...facts('Submit answers', { isSubmit: true, inForm: true, tag: 'button' }),
      page: { url: viewport.url, title: 'Week 3 Quiz', headings: [], hasChallenge: false },
    };
    expect(
      await assess('click_visual_target', { screenshotId: data.screenshotId, pointId: 'p1' }),
    ).toMatchObject({ result: { code: 'assessment_submission', stopTask: true } });
  });

  it('cannot click into a CAPTCHA', async () => {
    const { data } = await findPoint(point);
    describeFacts = facts('Verify', { isChallenge: true });
    expect(
      await assess('click_visual_target', { screenshotId: data.screenshotId, pointId: 'p1' }),
    ).toMatchObject({ result: { code: 'security_challenge' } });
  });
});

describe('fault injection: screenshots', () => {
  it('discards an image if the user moved to another tab during capture', async () => {
    capture.mockImplementation(async () => {
      tab = { ...tab, active: false };
      return IMAGE;
    });
    const result = await vision.assessCapture('analyze_screenshot', 1, context);
    expect(result).toMatchObject({ decision: 'block', result: { code: 'tab_not_visible' } });
    expect(image.process).not.toHaveBeenCalled();
  });

  it('discards an image if the page scrolled during capture, since masks would miss', async () => {
    capture.mockImplementation(async () => {
      snapshot = { ...snapshot, viewport: { ...viewport, scrollY: viewport.scrollY + 300 } };
      return IMAGE;
    });
    const result = await vision.assessCapture('analyze_screenshot', 1, context);
    expect(result).toMatchObject({ decision: 'block', result: { code: 'page_moving' } });
    expect(image.process).not.toHaveBeenCalled();
  });

  it('discards an image if a secret field moved during capture', async () => {
    capture.mockImplementation(async () => {
      snapshot = { ...snapshot, secretBoxes: [[0, 400, 100, 20]] };
      return IMAGE;
    });
    const result = await vision.assessCapture('analyze_screenshot', 1, context);
    expect(result).toMatchObject({ decision: 'block', result: { code: 'page_moving' } });
  });

  it('sends the image the user approved, however long they took to decide', async () => {
    const asked = await vision.assessCapture('analyze_screenshot', 1, context);
    expect(asked).toMatchObject({ decision: 'approve' });
    const shown = (asked as { screenshotId: string }).screenshotId;
    time += SCREENSHOT_REUSE_MS + 5000;
    capture.mockClear();
    replies = ['Answer.'];
    const result = await vision.execute('analyze_screenshot', { question: 'x' }, 1, context);
    expect(capture).not.toHaveBeenCalled();
    expect(result.ok && (result.data as { screenshotId: string }).screenshotId).toBe(shown);
  });

  it('asks again with a fresh image if the page changed while they decided', async () => {
    const asked = await vision.assessCapture('analyze_screenshot', 1, context);
    const shown = (asked as { screenshotId: string }).screenshotId;
    snapshot = { ...snapshot, viewport: { ...viewport, fingerprint: 'different' } };
    const again = await vision.assessCapture('analyze_screenshot', 1, context);
    expect((again as { screenshotId: string }).screenshotId).not.toBe(shown);
  });

  it('keeps boxes and coordinates right when retrying with a smaller image', async () => {
    image.process.mockImplementation(async (_url: string, options: { maxEdge?: number }) =>
      options.maxEdge
        ? { dataUrl: IMAGE, width: 640, height: 360 }
        : { dataUrl: IMAGE, width: 1280, height: 720 },
    );
    await vision.assessCapture('get_visual_page_context', 1, context);
    replies = [
      new ModelError('image_rejected', 'Too big.'),
      JSON.stringify({ description: 'd', targets: [], points: [{ x: 320, y: 180 }] }),
    ];
    const result = await vision.execute('get_visual_page_context', { question: 'x' }, 1, context);
    // The marked-up image is what gets shrunk, and the model is told its new size.
    expect(image.process.mock.lastCall?.[0]).toBe(IMAGE);
    const retried = requests.at(-1)?.messages.at(-1)?.content as { text?: string }[];
    expect(retried[0]?.text).toContain('640x360');
    const { screenshotId, points } = (
      result as { data: { screenshotId: string; points: { pointId: string }[] } }
    ).data;
    const target = await vision.ground(screenshotId, points[0]?.pointId ?? '', 1);
    // 320 of 640 is halfway across, whichever image the model was looking at.
    expect(target).toMatchObject({
      viewportPoint: { x: viewport.width / 2, y: viewport.height / 2 },
    });
  });

  it('says when a substitute model answered, rather than swapping quietly', async () => {
    status = { ...status, selectedVisionModel: 'retired-vision' };
    await vision.assessCapture('analyze_screenshot', 1, context);
    replies = [new ModelError('model_unavailable', 'Gone.'), 'Answer.'];
    const result = await vision.execute('analyze_screenshot', { question: 'x' }, 1, context);
    expect(result).toMatchObject({
      ok: true,
      summary: expect.stringMatching(/retired-vision was not available/),
    });
  });

  it('does not guess when the page has moved since the screenshot', async () => {
    await vision.assessCapture('get_visual_page_context', 1, context);
    replies = [JSON.stringify({ description: 'd', points: [{ x: 10, y: 10 }] })];
    const result = await vision.execute('get_visual_page_context', { question: 'x' }, 1, context);
    const { screenshotId, points } = (
      result as { data: { screenshotId: string; points: { pointId: string }[] } }
    ).data;
    snapshot = { ...snapshot, viewport: { ...viewport, scrollY: viewport.scrollY + 200 } };
    const target = await vision.ground(screenshotId, points[0]?.pointId ?? '', 1);
    expect(target).toMatchObject({ failure: { code: 'stale_screenshot' } });
  });
});
