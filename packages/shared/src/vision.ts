import { z } from 'zod';
import type { GroqModel } from './groq.js';

/** Longest image edge sent to a vision model. Groq counts images at a flat token cost. */
export const MAX_SCREENSHOT_EDGE = 1280;
export const SCREENSHOT_QUALITY = 0.65;
export const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;
/** Older than this, a screenshot says too little about the page to act on. */
export const MAX_SCREENSHOT_AGE_MS = 60_000;
/** Within this age an unchanged page is not captured again. */
export const SCREENSHOT_REUSE_MS = 15_000;

export const DEFAULT_VISION_FALLBACK = 'qwen/qwen3.8-27b';

const PREFERRED_FOR_VISION = [/qwen3\.8/i, /qwen3\.\d/i, /muse-spark/i, /llama-4/i, /vision/i];

/** Groq's model list has no capability field, so this goes by name. Others are never guessed at. */
export function rankVisionModels(models: GroqModel[]): GroqModel[] {
  const rank = (id: string) => PREFERRED_FOR_VISION.findIndex((pattern) => pattern.test(id));
  return models
    .filter((model) => rank(model.id) !== -1)
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

export const BoxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Box = z.infer<typeof BoxSchema>;

/** Where the page was when it was looked at. Anything acting on a screenshot compares this. */
export const ViewportStateSchema = z.strictObject({
  /** Without query string or fragment. */
  url: z.string(),
  title: z.string(),
  width: z.number().positive(),
  height: z.number().positive(),
  scrollX: z.number(),
  scrollY: z.number(),
  dpr: z.number().positive(),
  /** Changes when the controls on screen change. */
  fingerprint: z.string(),
});
export type ViewportState = z.infer<typeof ViewportStateSchema>;

export const VisualElementSchema = z.strictObject({
  ref: z.string(),
  role: z.string(),
  name: z.string(),
  box: BoxSchema,
  /** A plain colour name, so "the blue button" can often be settled without a guess. */
  color: z.string().optional(),
});
export type VisualElement = z.infer<typeof VisualElementSchema>;

export const VisualSnapshotSchema = z.strictObject({
  viewport: ViewportStateSchema,
  hasChallenge: z.boolean(),
  elements: z.array(VisualElementSchema),
  /** Password, card and code fields, painted over before any image leaves the browser. */
  secretBoxes: z.array(BoxSchema),
  /** Other documents on screen, whose contents cannot be inspected or targeted. */
  frameCount: z.number().int().nonnegative(),
});
export type VisualSnapshot = z.infer<typeof VisualSnapshotSchema>;

export const GroundedPointSchema = z.strictObject({
  kind: z.enum(['element', 'frame', 'nothing']),
  ref: z.string().optional(),
  interactive: z.boolean().optional(),
});
export type GroundedPoint = z.infer<typeof GroundedPointSchema>;

export interface ScreenshotRecord {
  id: string;
  tabId: number;
  capturedAt: number;
  viewport: ViewportState;
  /** The size of the image, which is usually smaller than the viewport. */
  imageWidth: number;
  imageHeight: number;
}

const POSITION_TOLERANCE_PX = 2;

/**
 * Why a screenshot can no longer be trusted, or null if it can. Coordinates and targets
 * only mean something on the page that was photographed, so any doubt rejects it.
 */
export function checkScreenshotFresh(
  shot: ScreenshotRecord,
  tabId: number,
  current: ViewportState,
  now: number,
): string | null {
  if (shot.tabId !== tabId) return 'That screenshot is of a different tab.';
  if (now - shot.capturedAt > MAX_SCREENSHOT_AGE_MS) return 'That screenshot is too old.';
  if (shot.viewport.url !== current.url) return 'The page has navigated since that screenshot.';
  if (shot.viewport.width !== current.width || shot.viewport.height !== current.height) {
    return 'The window has changed size since that screenshot.';
  }
  if (
    Math.abs(shot.viewport.scrollX - current.scrollX) > POSITION_TOLERANCE_PX ||
    Math.abs(shot.viewport.scrollY - current.scrollY) > POSITION_TOLERANCE_PX
  ) {
    return 'The page has scrolled since that screenshot.';
  }
  if (shot.viewport.fingerprint !== current.fingerprint) {
    return 'The page has changed since that screenshot.';
  }
  return null;
}

/** Converts a point on the image to page coordinates, or null if it is outside the image. */
export function imagePointToViewport(
  point: { x: number; y: number },
  shot: Pick<ScreenshotRecord, 'imageWidth' | 'imageHeight' | 'viewport'>,
): { x: number; y: number } | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  if (point.x < 0 || point.y < 0 || point.x >= shot.imageWidth || point.y >= shot.imageHeight) {
    return null;
  }
  return {
    x: (point.x * shot.viewport.width) / shot.imageWidth,
    y: (point.y * shot.viewport.height) / shot.imageHeight,
  };
}

/** Converts a page box to image coordinates, for painting over secrets and marking controls. */
export function viewportBoxToImage(box: Box, scale: { x: number; y: number }): Box {
  return [box[0] * scale.x, box[1] * scale.y, box[2] * scale.x, box[3] * scale.y];
}

const IMAGE_SIGNATURES: Record<string, string> = {
  'image/jpeg': '/9j/',
  'image/png': 'iVBOR',
  'image/webp': 'UklGR',
};

/** Checks a captured image is what it claims to be, before it is processed or sent. */
export function validateImageDataUrl(dataUrl: unknown): string | null {
  if (typeof dataUrl !== 'string') return 'The capture returned no image.';
  const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) return 'The capture did not return a valid image.';
  const [, type = '', data = ''] = match;
  const signature = IMAGE_SIGNATURES[type];
  if (!signature) return 'That image type is not supported.';
  if (!data.startsWith(signature)) return 'The image data does not match its type.';
  if ((data.length * 3) / 4 > MAX_SCREENSHOT_BYTES) return 'The image is too large.';
  return null;
}

const SENSITIVE_PAGE = /(checkout|payment|billing|bank|wallet|credit.?card|password|tax return)/i;

/** Pages where a screenshot deserves a specific warning, on top of masking fields. */
export function looksSensitive(page: { url: string; title: string }): boolean {
  return SENSITIVE_PAGE.test(`${page.url} ${page.title}`);
}
