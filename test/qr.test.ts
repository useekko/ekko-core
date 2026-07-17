import { afterEach, describe, expect, it, vi } from 'vitest';
import QRCode from 'qrcode';
import { generateIdentity } from '../src/core/crypto.js';
import { formatInvite } from '../src/core/wire.js';
import {
  decodeEkkoQr,
  decodeQrPixels,
  IDENTITY_QR_OPTIONS,
  pickEkkoInvite,
  type QrPixels,
} from '../src/popup/qr.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function raster(value: string): QrPixels {
  const modules = QRCode.create([{ data: new TextEncoder().encode(value), mode: 'byte' }], {
    errorCorrectionLevel: IDENTITY_QR_OPTIONS.errorCorrectionLevel,
  }).modules;
  const { margin, scale } = IDENTITY_QR_OPTIONS;
  const width = (modules.size + margin * 2) * scale;
  const data = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const row = Math.floor(y / scale) - margin;
      const column = Math.floor(x / scale) - margin;
      const dark = row >= 0 && column >= 0 && row < modules.size && column < modules.size && modules.get(row, column);
      const offset = (y * width + x) * 4;
      data[offset] = data[offset + 1] = data[offset + 2] = dark ? 0 : 255;
      data[offset + 3] = 255;
    }
  }
  return { width, height: width, data };
}

describe('QR invite import', () => {
  it('accepts one unique standalone invite and refuses missing, embedded, or ambiguous codes', () => {
    expect(pickEkkoInvite(['RSN1I:alice', 'RSN1I:alice'])).toEqual({ invite: 'RSN1I:alice' });
    expect(pickEkkoInvite([])).toEqual({ error: 'no-code' });
    expect(pickEkkoInvite(['https://example.com', 'RSN1M:not-an-invite'])).toEqual({ error: 'no-invite' });
    expect(pickEkkoInvite(['https://example.com/?invite=RSN1I:alice'])).toEqual({ error: 'no-invite' });
    expect(pickEkkoInvite(['RSN1I:alice', 'RSN1I:bob'])).toEqual({ error: 'multiple-invites' });
  });

  it('decodes a full post-quantum invite at the identity QR render density', async () => {
    const invite = formatInvite(generateIdentity().bundle);
    const pixels = raster(invite);
    expect(invite).toHaveLength(1629);
    expect(pixels.width).toBe(290);
    expect(await decodeQrPixels(pixels)).toEqual({ invite });
  });

  it('falls back locally when the native detector stalls', async () => {
    vi.useFakeTimers();
    const invite = formatInvite(generateIdentity().bundle);
    const pixels = raster(invite);
    const close = vi.fn();
    class StalledDetector {
      static async getSupportedFormats(): Promise<string[]> {
        return ['qr_code'];
      }
      detect(): Promise<never> {
        return new Promise(() => undefined);
      }
    }
    vi.stubGlobal('BarcodeDetector', StalledDetector);
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: pixels.width, height: pixels.height, close }));
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: vi.fn(), getImageData: () => pixels }),
      }),
    });

    const result = decodeEkkoQr(new Blob(['image']));
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ invite });
    expect(close).toHaveBeenCalledOnce();
  });
});
