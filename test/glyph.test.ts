// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ComposerGlyph } from '../src/content/glyph.js';
import type { ChatActions } from '../src/content/adapter.js';

// jsdom without pretendToBeVisual has no rAF; the glyph throttles repositioning through it.
globalThis.requestAnimationFrame ??= ((cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 16) as unknown as number) as typeof requestAnimationFrame;

const ACTIONS = {
  enable() {},
  acceptInvite() {},
  disable() {},
  unlock() {},
  plainOnce() {},
  retry() {},
  invitePeer() {},
} as ChatActions;

// The orphan watchdog (boot.ts) calls destroy() when the extension context dies. Without
// it, the 350ms track interval polls the page forever and the glyph node lingers as
// zombie UI frozen on stale state.
describe('composer glyph — orphan teardown', () => {
  it('destroy() removes the node and stops the anchor polling', async () => {
    const anchor = document.createElement('div');
    document.body.appendChild(anchor);
    const spy = vi.fn(() => anchor);
    const glyph = new ComposerGlyph(spy, 'WhatsApp', 'whatsapp', 60000);
    glyph.update({ kind: 'on', label: 'Maya' }, ACTIONS);
    expect(document.getElementById('rsn-glyph')).not.toBeNull();

    await new Promise((r) => setTimeout(r, 450)); // at least one 350ms track tick
    expect(spy.mock.calls.length).toBeGreaterThan(0);

    glyph.destroy();
    expect(document.getElementById('rsn-glyph')).toBeNull();
    await new Promise((r) => setTimeout(r, 50)); // drain a queued rAF, if any
    const settled = spy.mock.calls.length;
    await new Promise((r) => setTimeout(r, 800));
    expect(spy.mock.calls.length).toBe(settled); // interval and window listeners are gone
  });
});
