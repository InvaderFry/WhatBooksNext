import { createCanvas, loadImage } from '@napi-rs/canvas';
import { MAX_IMAGE_PIXELS, THUMBNAIL_MAX_SIDE, THUMBNAIL_QUALITY } from '../../config.ts';
import { imageInfo } from './images.ts';
import { LimitError } from './zip.ts';

/**
 * Thumbnails with @napi-rs/canvas (prebuilt binaries, no install script; also what pdf.js uses
 * to render pages in Node), so there is one native image library rather than two. The pixel
 * limit is checked from the image header before decoding (§6.1, §20).
 */
export async function thumbnailFromImage(bytes: Uint8Array): Promise<Buffer> {
  const info = imageInfo(bytes);
  if (!info) throw new Error('The cover image is in a format that can’t be read.');
  if (info.width * info.height > MAX_IMAGE_PIXELS)
    throw new LimitError('pixels', 'The cover image is larger than 50 megapixels.');
  // loadImage, not `new Image().src = …`: the synchronous form reports the size but draws
  // nothing, which gave blank covers.
  const img = await loadImage(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return drawScaled(img, img.width, img.height);
}

export function drawScaled(
  source: Parameters<ReturnType<ReturnType<typeof createCanvas>['getContext']>['drawImage']>[0],
  width: number,
  height: number,
): Buffer {
  if (!width || !height) throw new Error('The cover image is empty.');
  const scale = Math.min(1, THUMBNAIL_MAX_SIDE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; // transparent PNG covers get a white page, not black
  g.fillRect(0, 0, w, h);
  g.drawImage(source, 0, 0, w, h);
  return c.toBuffer('image/jpeg', THUMBNAIL_QUALITY);
}
