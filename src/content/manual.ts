// Standalone "Seal for a contact" for pages with no Ekko adapter — email, docs, anything.
// The background injects this on the seal-anywhere shortcut (activeTab makes that legal
// because the user pressed it); the editable holding the caret at that moment is the
// sealing target. Adapter pages never load this file: their boot answers the same message.
import { openSealOverlay, targetFromActiveElement } from './seal.js';

const FLAG = '__rsnSealAnywhere';
const w = window as unknown as Record<string, unknown>;
// A shortcut race can inject twice before the first listener answers; the flag makes the
// second injection inert instead of stacking a second listener and a second overlay.
if (!w[FLAG]) {
  w[FLAG] = true;
  chrome.runtime.onMessage.addListener((req: { type?: string }, _sender, sendResponse) => {
    if (req?.type === 'sealAnywhere') {
      openSealOverlay(targetFromActiveElement());
      sendResponse({ ok: true });
    }
  });
  openSealOverlay(targetFromActiveElement()); // this injection IS the first shortcut press
}
