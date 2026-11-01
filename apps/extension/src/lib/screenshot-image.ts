import { MAX_SCREENSHOT_EDGE, SCREENSHOT_QUALITY } from '@dopilot/shared';
import type { Box } from '@dopilot/shared';

export interface ProcessedImage {
  dataUrl: string;
  width: number;
  height: number;
}

export interface ImageMark {
  label: string;
  box: Box;
}

/** Image work for screenshots. Separate, because it needs a real browser to run. */
export interface ImagePort {
  /** Resizes and compresses, painting over `masks`, which are in viewport pixels. */
  process(
    dataUrl: string,
    options: { viewportWidth: number; viewportHeight: number; masks: Box[]; maxEdge?: number },
  ): Promise<ProcessedImage>;
  /** Draws numbered boxes, in image pixels, so a model can refer to real elements. */
  annotate(dataUrl: string, marks: ImageMark[]): Promise<string>;
}

// The extension's security policy blocks fetch() on data: URLs, so this decodes directly.
function decode(dataUrl: string): Blob {
  const [header = '', data = ''] = dataUrl.split(',', 2);
  const type = /^data:([^;]+)/.exec(header)?.[1] ?? 'image/jpeg';
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type });
}

async function encode(canvas: OffscreenCanvas): Promise<string> {
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: SCREENSHOT_QUALITY });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

function context2d(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas unavailable');
  return context;
}

export const browserImagePort: ImagePort = {
  async process(dataUrl, { viewportWidth, viewportHeight, masks, maxEdge = MAX_SCREENSHOT_EDGE }) {
    const bitmap = await createImageBitmap(decode(dataUrl));
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = context2d(canvas);
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    context.fillStyle = '#000';
    const toImageX = width / viewportWidth;
    const toImageY = height / viewportHeight;
    for (const [x, y, w, h] of masks) {
      context.fillRect(x * toImageX - 1, y * toImageY - 1, w * toImageX + 2, h * toImageY + 2);
    }
    return { dataUrl: await encode(canvas), width, height };
  },

  async annotate(dataUrl, marks) {
    const bitmap = await createImageBitmap(decode(dataUrl));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = context2d(canvas);
    context.drawImage(bitmap, 0, 0);
    bitmap.close();

    context.font = 'bold 13px sans-serif';
    context.textBaseline = 'top';
    for (const { label, box } of marks) {
      const [x, y, w, h] = box;
      context.strokeStyle = '#ff00aa';
      context.lineWidth = 2;
      context.strokeRect(x, y, w, h);
      const tagWidth = context.measureText(label).width + 6;
      context.fillStyle = '#ff00aa';
      context.fillRect(x, Math.max(0, y - 16), tagWidth, 16);
      context.fillStyle = '#fff';
      context.fillText(label, x + 3, Math.max(0, y - 16) + 2);
    }
    return encode(canvas);
  },
};
