import { classifyStandalone } from '../core/wire.js';

export const IDENTITY_QR_OPTIONS = { errorCorrectionLevel: 'L' as const, margin: 4, scale: 2 };

export type QrDecodeResult =
  | { invite: string }
  | { error: 'unsupported' | 'too-large' | 'unreadable' | 'no-code' | 'no-invite' | 'multiple-invites' };

export interface QrPixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

type QrDetector = { detect(source: ImageBitmapSource): Promise<Array<{ rawValue: string }>> };
type QrDetectorConstructor = {
  new (options: { formats: string[] }): QrDetector;
  getSupportedFormats(): Promise<string[]>;
};

let detectorPromise: Promise<QrDetector | null> | undefined;
const NATIVE_DEADLINE_MS = 800;

async function beforeDeadline<T>(promise: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = globalThis.setTimeout(() => resolve(null), NATIVE_DEADLINE_MS);
  });
  const result = await Promise.race([promise.then((value) => value, () => null), timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

function detector(): Promise<QrDetector | null> {
  return (detectorPromise ??= (async () => {
    const Ctor = (globalThis as typeof globalThis & { BarcodeDetector?: QrDetectorConstructor }).BarcodeDetector;
    if (!Ctor) return null;
    try {
      const formats = await beforeDeadline(Ctor.getSupportedFormats());
      return formats?.includes('qr_code') ? new Ctor({ formats: ['qr_code'] }) : null;
    } catch {
      return null;
    }
  })());
}

export function qrScanningSupported(): boolean {
  return typeof createImageBitmap === 'function' && typeof document !== 'undefined';
}

export function pickEkkoInvite(values: string[]): QrDecodeResult {
  if (values.length === 0) return { error: 'no-code' };
  const invites = [
    ...new Set(
      values.flatMap((value) => {
        const token = classifyStandalone(value);
        return token?.kind === 'invite' ? [token.raw] : [];
      }),
    ),
  ];
  if (invites.length === 0) return { error: 'no-invite' };
  if (invites.length > 1) return { error: 'multiple-invites' };
  return { invite: invites[0]! };
}

export async function decodeQrPixels(image: QrPixels): Promise<QrDecodeResult> {
  try {
    const { default: decodeQR } = await import('qr/decode.js');
    return pickEkkoInvite([decodeQR(image)]);
  } catch {
    return { error: 'no-code' };
  }
}

function pixelsFrom(bitmap: ImageBitmap): QrPixels | null {
  const ratio = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
  canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

export async function decodeEkkoQr(file: Blob): Promise<QrDecodeResult> {
  if (!qrScanningSupported()) return { error: 'unsupported' };
  if (file.size === 0) return { error: 'unreadable' };
  if (file.size > 16 * 1024 * 1024) return { error: 'too-large' };

  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    if (bitmap.width === 0 || bitmap.height === 0) return { error: 'unreadable' };
    if (bitmap.width * bitmap.height > 25_000_000) return { error: 'too-large' };

    const native = await detector();
    if (native) {
      try {
        const detected = await beforeDeadline(native.detect(bitmap));
        const values = detected?.map((result) => result.rawValue) ?? [];
        if (values.length > 0) return pickEkkoInvite(values);
      } catch {
        // Platform detector failed; the local decoder below keeps this flow portable.
      }
    }

    const pixels = pixelsFrom(bitmap);
    return pixels ? decodeQrPixels(pixels) : { error: 'unsupported' };
  } catch {
    return { error: 'unreadable' };
  } finally {
    bitmap?.close();
  }
}
