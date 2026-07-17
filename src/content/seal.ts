// "Seal for a contact" — manual encryption for surfaces Ekko can't vouch for: an email
// draft, a doc, a chat the adapter couldn't identify. The user writes WHERE THEY'LL SEND,
// picks a person, and Ekko replaces the draft with sealed wire text in place. Nothing is
// auto-sent, no thread is bound, no surface is remembered; the recipient pastes the blocks
// into Ekko to read them (the popup's manual contract). Deliberately a different ceremony
// from automatic chat encryption: the flow is two-step, wears the amber "by hand" family
// instead of coral, and makes the user vouch for the recipient — Ekko can verify a key,
// but only the user can verify that THIS page reaches THAT person.
//
// Same in-page rules as the glyph: a closed shadow root, buttons and labels only — never a
// text input (key events re-target but still bubble out of shadow roots, so an in-page
// field would hand every keystroke to the host page; that's also why there is no
// type-to-filter on the contact list).
import { send } from '../core/rpc.js';
import type { ContactView } from '../core/rpc.js';
import { splitMessage, randomChunkId } from '../core/chunk.js';
import { injectStyle, placeInComposer, readComposerNode, toast } from './dom.js';

// What the overlay seals into. `read` is best-effort ('' = nothing to seal yet); `write`
// must end with the surface holding exactly the sealed text, or report failure so the
// clipboard fallback runs. `hint` names the surface in the user's terms.
export interface SealTarget {
  read(): string;
  write(text: string): Promise<boolean>;
  hint: string;
  maxLen?: number; // messenger surfaces chunk to their send cap; free surfaces don't chunk
  el?: () => HTMLElement | null; // where the surface lives, for placing the card beside it
}

async function writeEditable(el: HTMLElement, text: string): Promise<boolean> {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.focus();
    el.select();
    if (!document.execCommand('insertText', false, text)) {
      // React-controlled fields ignore direct .value writes; go through the prototype
      // setter and announce the change the way the framework listens for it.
      const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // A single-line input strips the newlines between blocks — that reads as failure and
    // correctly routes multi-block seals to the clipboard.
    return el.value.trim() === text.trim();
  }
  return !!(await placeInComposer(() => (el.isConnected ? el : null), text));
}

// The generic entry (keyboard shortcut): seal whatever editable held the caret when the
// shortcut fired. Captured once — the overlay steals focus the moment it opens.
export function targetFromActiveElement(): SealTarget | null {
  let el = document.activeElement as HTMLElement | null;
  // The caret can live inside a shadow widget (docs editors); descend to the real focus.
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement as HTMLElement;
  const editable =
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      ? el
      : (el?.closest<HTMLElement>('[contenteditable="true"], [contenteditable=""]') ?? null);
  if (!editable) return null;
  return {
    read: () => (editable.isConnected ? readComposerNode(editable) : ''),
    write: (text) => writeEditable(editable, text),
    hint: 'The message you were writing on this page',
    el: () => (editable.isConnected ? editable : null),
  };
}

// The glyph entry: seal the platform composer the glyph is anchored to.
export function composerTarget(getEl: () => HTMLElement | null, platformLabel: string, maxLen: number): SealTarget {
  return {
    read: () => {
      const el = getEl();
      return el ? readComposerNode(el) : '';
    },
    write: async (text) => !!(await placeInComposer(getEl, text)),
    hint: `The message box in this ${platformLabel} chat`,
    maxLen,
    el: getEl,
  };
}

const KBD = /mac/i.test(navigator.platform) ? '⌘⇧E' : 'Ctrl+Shift+E';

// Same stable hash → hue as the popup's avatars: one person, one colour, everywhere.
const AV = ['#ff5f52', '#57c088', '#d9a13d', '#5b9df0', '#5bb8c4', '#b98cf0'];
const avatarColor = (seed: string): string => {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AV[h % AV.length]!;
};
const initials = (label: string) =>
  label
    .replace(/^@/, '')
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || '?';

const CSS = `
  :host { all: initial; }
  #card {
    position: fixed; z-index: 2147483647; width: 304px; box-sizing: border-box;
    background: #16181d; color: #e8eaee; border: 1px solid rgba(255,255,255,.09);
    border-radius: 14px; padding: 15px 16px 14px; box-shadow: 0 14px 44px rgba(0,0,0,.45);
    font: 400 12.5px/1.5 system-ui, -apple-system, sans-serif;
    animation: rsn-seal-in .18s ease-out;
  }
  @keyframes rsn-seal-in { from { opacity: 0; transform: translateY(6px); } }
  @media (prefers-reduced-motion: reduce) { #card { animation: none; } }
  /* The manual family is amber on purpose: coral invites automatic encryption; amber is
     the deliberate, check-it-yourself register (plain-once and locked already speak it). */
  .kicker {
    font: 600 10px/1 system-ui, -apple-system, sans-serif; letter-spacing: .14em;
    color: #d9a13d; text-transform: uppercase; margin: 0 0 7px; display: block;
  }
  h1 { font-size: 13.5px; font-weight: 600; margin: 0 0 4px; color: #e8eaee; }
  p { margin: 5px 0 0; color: #9aa3b2; }
  p.warn { color: #ecd9a8; }
  p.err { color: #f0a9a2; }
  #x {
    position: absolute; top: 9px; right: 9px; width: 24px; height: 24px; border: none;
    border-radius: 7px; background: transparent; color: #8a93a2; font: 500 13px system-ui;
    cursor: pointer; display: inline-flex; align-items: center; justify-content: center; padding: 0;
  }
  #x:hover { background: rgba(255,255,255,.08); color: #e8eaee; }
  .preview {
    margin: 9px 0 0; padding: 8px 10px; border-radius: 9px;
    background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.07);
    color: #b9c0cc; font-size: 11.5px; line-height: 1.5; overflow: hidden;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3;
    white-space: pre-wrap; overflow-wrap: anywhere;
  }
  .src { margin: 5px 0 0; color: #737d8c; font-size: 10.5px; }
  #list { margin-top: 10px; max-height: 208px; overflow-y: auto; }
  button { font: 600 12.5px system-ui, -apple-system, sans-serif; cursor: pointer; }
  .row {
    display: flex; align-items: center; gap: 9px; width: 100%; margin-top: 6px;
    padding: 7px 9px; border-radius: 9px; border: 1px solid rgba(255,255,255,.07);
    background: rgba(255,255,255,.04); color: #e8eaee; text-align: left;
  }
  .row:hover { background: rgba(255,255,255,.09); }
  .row .av {
    flex: none; width: 26px; height: 26px; border-radius: 50%; color: #fff;
    display: inline-flex; align-items: center; justify-content: center;
    font: 600 10.5px system-ui, -apple-system, sans-serif; letter-spacing: .02em;
  }
  .row .who { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .tick { flex: none; color: #57c088; font-size: 11px; font-weight: 600; }
  .btn {
    display: block; width: 100%; margin-top: 9px; padding: 8px 10px;
    border-radius: 9px; border: 1px solid rgba(255,255,255,.1);
    background: rgba(255,255,255,.05); color: #e8eaee;
  }
  .btn:hover { background: rgba(255,255,255,.1); }
  .btn.quiet { color: #9aa3b2; font-weight: 500; background: transparent; border-color: transparent; }
  .btn.quiet:hover { background: rgba(255,255,255,.06); }
  /* The one filled action the manual family owns: the coral CTA's glossy build, re-cut in
     amber with dark text (white fails on amber; dark reads as a wax seal pressed to sign). */
  .btn.seal {
    background: linear-gradient(180deg, color-mix(in srgb, #d9a13d 86%, #ffffff), #d9a13d 60%);
    border-color: color-mix(in srgb, #d9a13d 78%, #2a1d05);
    color: #221704;
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,.4),
      0 8px 22px -8px rgba(217,161,61,.5),
      0 2px 6px -2px rgba(217,161,61,.35);
  }
  .btn.seal:hover { filter: brightness(1.06); }
  .vouch {
    margin: 9px 0 0; padding: 8px 10px; border-radius: 9px; font-size: 11.5px;
    border: 1px solid rgba(217,161,61,.28); background: rgba(217,161,61,.07);
  }
  .vouch.ok { border-color: rgba(87,192,136,.25); background: rgba(87,192,136,.06); color: #b9e6cd; }
  .vouch.un { color: #ecd9a8; }
  .foot { margin: 10px 0 0; color: #737d8c; font-size: 10.5px; }
  .foot kbd {
    font: 500 10px ui-monospace, SFMono-Regular, Menlo, monospace; color: #9aa3b2;
    border: 1px solid rgba(255,255,255,.14); border-bottom-width: 2px;
    border-radius: 4px; padding: 1px 4px;
  }
  #card:focus-visible, button:focus-visible { outline: 2px solid #d9a13d; outline-offset: 2px; }
`;

type Step =
  | { name: 'loading' }
  | { name: 'locked' }
  | { name: 'no-contacts' }
  | { name: 'no-target' }
  | { name: 'empty' }
  | { name: 'pick' }
  | { name: 'vouch'; contact: ContactView; nudge?: string; err?: string }
  | { name: 'copied'; contact: ContactView; sealed: string };

class SealOverlay {
  private host: HTMLElement;
  private card: HTMLElement;
  private step: Step = { name: 'loading' };
  private contacts: ContactView[] = [];
  private captured = '';
  private track: () => void;
  private onKey: (e: KeyboardEvent) => void;

  constructor(
    private target: SealTarget | null,
    private anchor?: () => HTMLElement | null,
  ) {
    injectStyle(); // the toast this overlay ends on lives in the shared sheet
    this.host = document.createElement('div');
    this.host.id = 'rsn-seal';
    const root = this.host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style><div id="card" role="dialog" aria-label="Seal a message for a contact" tabindex="-1"></div>`;
    this.card = root.getElementById('card') as HTMLElement;
    document.documentElement.appendChild(this.host);

    this.onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.destroy();
      }
    };
    document.addEventListener('keydown', this.onKey, true);
    // rAF-throttled tracking, same as the glyph: the card must follow its surface.
    let queued = false;
    this.track = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        this.place();
      });
    };
    window.addEventListener('scroll', this.track, true);
    window.addEventListener('resize', this.track, true);

    this.captured = (this.target?.read() ?? '').trim();
    this.render();
    void this.open();
  }

  destroy(): void {
    document.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('scroll', this.track, true);
    window.removeEventListener('resize', this.track, true);
    this.host.remove();
    if (current === this) current = null;
  }

  private async open(): Promise<void> {
    if (!this.target) return this.set({ name: 'no-target' });
    if (!this.captured) return this.set({ name: 'empty' });
    const res = await send({ type: 'contacts' });
    if (res.error === 'locked' || res.error === 'no-vault') return this.set({ name: 'locked' });
    if (res.error || !res.contacts) return this.set({ name: 'locked' }); // unreachable reads as "open Ekko"
    if (res.contacts.length === 0) return this.set({ name: 'no-contacts' });
    this.contacts = res.contacts;
    this.set({ name: 'pick' });
  }

  private set(step: Step): void {
    this.step = step;
    this.render();
  }

  // ————— rendering (textContent for all user data; constant markup only) —————

  private el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    this.card.appendChild(n);
    return n;
  }

  private btn(cls: string, text: string, fn: (e: MouseEvent) => void): HTMLButtonElement {
    const b = this.el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn(e);
    });
    return b;
  }

  private preview(): void {
    this.el('div', 'preview', this.captured);
    if (this.target) this.el('p', 'src', this.target.hint);
  }

  private render(): void {
    const s = this.step;
    this.card.replaceChildren();
    const x = this.btn('', '✕', () => this.destroy());
    x.id = 'x';
    x.setAttribute('aria-label', 'Close');

    if (s.name === 'loading') {
      this.el('span', 'kicker', 'Seal by hand');
      this.el('h1', '', 'Getting your people…');
    } else if (s.name === 'no-target') {
      this.el('span', 'kicker', 'Seal by hand');
      this.el('h1', '', 'Click into your message');
      this.el('p', '', `Put the cursor in the box where you're writing, then press ${KBD}. Ekko seals the text right there.`);
    } else if (s.name === 'empty') {
      this.el('span', 'kicker', 'Seal by hand');
      this.el('h1', '', 'Write your message first');
      this.el('p', '', 'Type it where you normally would — an email draft, a chat box. Then seal it in place and send it yourself.');
      if (this.target) this.el('p', 'src', this.target.hint);
    } else if (s.name === 'locked') {
      this.el('span', 'kicker', 'Seal by hand');
      this.el('h1', '', 'Ekko is locked');
      this.el('p', '', 'Unlock it to seal this message.');
      this.btn('btn', 'Unlock Ekko', () => {
        void send({ type: 'openPopup' }).then((r) => {
          if (r.error) toast('Click the Ekko icon in your browser toolbar to unlock.');
        });
        this.destroy();
      });
    } else if (s.name === 'no-contacts') {
      this.el('span', 'kicker', 'Seal by hand');
      this.el('h1', '', 'No one to seal for yet');
      this.el('p', '', 'Sealing needs a contact whose key you hold. Open Ekko from your toolbar and add someone first.');
    } else if (s.name === 'pick') {
      this.el('span', 'kicker', 'Seal by hand');
      this.el('h1', '', 'Seal this message for…');
      this.preview();
      const list = this.el('div', '');
      list.id = 'list';
      for (const c of this.contacts) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'row';
        const av = document.createElement('span');
        av.className = 'av';
        av.style.background = avatarColor(c.fingerprint);
        av.textContent = initials(c.label);
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = c.label;
        row.append(av, who);
        if (c.verified) {
          const t = document.createElement('span');
          t.className = 'tick';
          t.textContent = '✓ verified';
          row.append(t);
        }
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          this.set({ name: 'vouch', contact: c });
        });
        list.appendChild(row);
      }
      this.el('p', 'foot', 'Sealed text replaces your draft in place. Nothing sends until you send it.');
    } else if (s.name === 'vouch') {
      const c = s.contact;
      this.el('span', 'kicker', 'You pick who can read it');
      this.el('h1', '', `Only ${c.label} will be able to read this`);
      this.el('p', '', `Ekko can't see who this page delivers to. Make sure this is really where you reach ${c.label} — the message only opens with their key.`);
      const v = this.el('div', c.verified ? 'vouch ok' : 'vouch un');
      v.textContent = c.verified
        ? '✓ You compared safety codes with them.'
        : 'You never compared safety codes with them. Seal anyway, and verify in Ekko when you can.';
      this.preview();
      if (s.nudge) this.el('p', 'warn', s.nudge);
      if (s.err) this.el('p', 'err', s.err);
      this.btn('btn seal', `Seal for ${c.label}`, (e) => void this.seal(c, e));
      this.btn('btn quiet', 'Back', () => this.set({ name: 'pick' }));
    } else if (s.name === 'copied') {
      this.el('span', 'kicker', 'Sealed and copied');
      this.el('h1', '', `Sealed for ${s.contact.label}`);
      this.el('p', '', "This editor wouldn't take the sealed text, so it's on your clipboard. Your draft is untouched — paste the sealed version over it.");
      this.btn('btn', 'Copy again', () => void copyText(s.sealed).then((ok) => toast(ok ? 'Copied.' : 'Copy failed — select the text and copy it yourself.')));
      this.btn('btn quiet', 'Done', () => this.destroy());
    }
    this.place();
    // The vouch step exists to be READ — focus its quiet "Back", not the amber seal
    // button, so Enter-Enter can never pick the first contact and seal in two keystrokes.
    const first =
      s.name === 'vouch'
        ? (this.card.querySelector<HTMLButtonElement>('button.quiet') ?? this.card.querySelector<HTMLButtonElement>('button:not(#x)'))
        : this.card.querySelector<HTMLButtonElement>('button:not(#x)');
    first?.focus();
  }

  private async seal(c: ContactView, e: MouseEvent): Promise<void> {
    // A page can't reach into this closed shadow root, but a synthetic click is still a
    // synthetic click — the one action that produces ciphertext takes real gestures only.
    if (!e.isTrusted || !this.target) return;
    // Re-read at the moment of commitment. If the draft moved since the preview, the
    // preview was the double-check — make them look again, don't seal a text they
    // haven't seen.
    const now = this.target.read().trim();
    if (!now) return this.set({ name: 'empty' });
    if (now !== this.captured) {
      this.captured = now;
      return this.set({ name: 'vouch', contact: c, nudge: 'The message changed since you looked — read it again, then seal.' });
    }
    const res = await send({ type: 'sealFor', fingerprint: c.fingerprint, plaintext: now });
    if (res.error === 'locked' || res.error === 'no-vault') return this.set({ name: 'locked' });
    if (res.error || !res.tokens) {
      return this.set({ name: 'vouch', contact: c, err: 'Ekko couldn’t seal this message. Reload the page and try again.' });
    }
    let parts = res.tokens;
    if (this.target.maxLen) {
      try {
        parts = res.tokens.flatMap((t) => splitMessage(t, this.target!.maxLen!, randomChunkId()));
      } catch {
        return this.set({ name: 'vouch', contact: c, err: 'That message is too long to seal in one go. Split it and seal the parts separately.' });
      }
    }
    const sealed = parts.join('\n\n');
    if (await this.target.write(sealed)) {
      toast(`Sealed for ${c.label}. Send it when you're ready — only they can open it.`);
      this.destroy();
      return;
    }
    await copyText(sealed);
    this.set({ name: 'copied', contact: c, sealed });
  }

  // Above the surface it seals when we know where that is; bottom-right otherwise.
  private place(): void {
    const r = (this.anchor ?? this.target?.el)?.()?.getBoundingClientRect();
    const c = this.card.getBoundingClientRect();
    if (r && r.width > 0) {
      this.card.style.left = `${Math.max(8, Math.min(r.right - c.width, window.innerWidth - c.width - 8))}px`;
      this.card.style.top = `${Math.max(8, r.top - c.height - 10)}px`;
      this.card.style.bottom = '';
    } else {
      this.card.style.left = `${Math.max(8, window.innerWidth - c.width - 20)}px`;
      this.card.style.top = '';
      this.card.style.bottom = '20px';
    }
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API can be denied on some host pages; the selection fallback still works.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

let current: SealOverlay | null = null;

// One overlay at a time; opening again replaces it (fresh capture, fresh contact list).
// `anchor` positions the card over the surface being sealed, when the caller knows it.
// Returns the instance for harness-driven state screenshots; product callers ignore it.
export function openSealOverlay(target: SealTarget | null, anchor?: () => HTMLElement | null): unknown {
  current?.destroy();
  current = new SealOverlay(target, anchor);
  return current;
}
