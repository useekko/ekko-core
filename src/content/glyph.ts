// Grammarly-style composer glyph: one small button anchored INSIDE the message box that
// shows the open chat's encryption state at a glance, plus an anchored popover for the
// actions that must not require the toolbar popup (encrypt this chat, send-one-plain,
// turn off, unlock). Platform-independent: adapters hand it a `anchor()` that returns
// the composer element; positioning is rect-computed fixed, tracked via scroll/resize
// listeners and a slow interval (SPA re-renders replace the composer node).
//
// Lives in a closed shadow root so the host page's CSS/scripts can't reach in. It renders
// ONLY buttons and labels — never a password field — so page-level keyloggers (key events
// re-target but still bubble out of shadow roots) have nothing to capture. Unlock happens
// in the extension popup, not in-page.
import type { ChatState, ChatActions } from './adapter.js';
import { send } from '../core/rpc.js';
import { toast } from './dom.js';
import { composerTarget, openSealOverlay } from './seal.js';
import { ICON_LOCK, ICON_UNLOCKED } from './icons.js';

const ICON_POWER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M12 3.5v8"/><path d="M6.3 6.6a8 8 0 1 0 11.4 0"/></svg>';

// ChatState is a small closed union; compare every field any variant carries.
function chatStateEquals(a: ChatState, b: ChatState): boolean {
  type Flat = {
    kind: string;
    label?: string;
    plainOnce?: boolean;
    suggestLabel?: string;
    onEkko?: boolean;
    invite?: string;
    inviteKind?: string;
    peer?: string;
  };
  const x = a as Flat;
  const y = b as Flat;
  return (
    x.kind === y.kind &&
    x.label === y.label &&
    x.plainOnce === y.plainOnce &&
    x.suggestLabel === y.suggestLabel &&
    x.onEkko === y.onEkko &&
    x.invite === y.invite &&
    x.inviteKind === y.inviteKind &&
    x.peer === y.peer
  );
}

const CSS = `
  :host { all: initial; }
  #g {
    position: fixed; width: 24px; height: 24px; border-radius: 50%;
    display: none; align-items: center; justify-content: center;
    border: none; cursor: pointer; padding: 0; z-index: 2147483646;
    background: transparent; transition: background .15s;
  }
  #g.shown { display: inline-flex; }
  #g:hover { background: rgba(128,128,128,.16); }
  #g:focus-visible, #p button:focus-visible { outline: 2px solid #ff5f52; outline-offset: 2px; }
  #g svg { width: 15px; height: 15px; }
  #g.off { color: #8a93a2; }
  /* Grammarly-style power reveal: hovering (or focusing) the glyph slides a second small
     circle out on the leading side, and a frosted pill rises behind BOTH so they read as
     one control. Two classes because display can't transition: .out enters layout, .in
     plays the slide/fade. */
  #w {
    position: fixed; width: 24px; height: 24px; border-radius: 50%;
    display: none; align-items: center; justify-content: center;
    border: none; cursor: pointer; padding: 0; z-index: 2147483646;
    background: transparent; color: #6f7887;
    opacity: 0; transform: translateX(5px);
    transition: opacity .15s ease, transform .15s ease, background .15s;
  }
  #w.out { display: inline-flex; }
  #w.in { opacity: 1; transform: none; }
  #w:hover { background: rgba(128,128,128,.18); color: #3d4553; }
  #w:focus-visible { outline: 2px solid #ff5f52; outline-offset: 2px; opacity: 1; transform: none; }
  #w svg { width: 14px; height: 14px; }
  /* The joining pill: a quiet glass capsule that works over light AND dark composers —
     translucent neutral + backdrop blur, hairline mid-gray border, soft lift. */
  #pl {
    position: fixed; height: 30px; border-radius: 15px; z-index: 2147483645;
    display: none; pointer-events: none;
    background: rgba(139, 145, 158, .14);
    border: 1px solid rgba(127, 132, 145, .26);
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    box-shadow: 0 2px 10px rgba(0, 0, 0, .14);
    opacity: 0; transition: opacity .15s ease;
  }
  #pl.out { display: block; }
  #pl.in { opacity: 1; }
  @media (prefers-reduced-motion: reduce) { #w, #pl { transition: none; } }
  /* Touch has no hover: the power circle and pill never appear; the popover carries the row. */
  @media (hover: none) { #w, #pl { display: none !important; } }
  /* Grace period: 'unknown' is usually a sub-second transient on load; fading in after a
     delay means fast resolutions never show a lock→unlocked icon flip. */
  #g.unknown { color: #8a93a2; opacity: 0; animation: rsn-appear .2s ease .6s forwards; }
  @keyframes rsn-appear { to { opacity: .8; } }
  @media (prefers-reduced-motion: reduce) { #g.unknown { animation: none; opacity: .8; } }
  /* Brand accent, DESIGN.md tokens (mirror popup.html): the icon wears --accent-deep
     #d63d30 — the small-mark weight that holds >4:1 on light AND dark composers, where
     pure coral fails on paper — and the ring pulses pure coral #ff5f52. */
  #g.offer { color: #d63d30; animation: rsn-offer 2.2s ease-out 2; }
  @keyframes rsn-offer {
    0% { box-shadow: 0 0 0 0 rgba(255,95,82,.4); }
    65%, 100% { box-shadow: 0 0 0 9px rgba(255,95,82,0); }
  }
  @media (prefers-reduced-motion: reduce) { #g.offer, #g.busy::after { animation: none; } }
  #g.on { color: #4a9d6e; }
  #g.plain-once { color: #a8842f; }
  #g.locked { color: #a8842f; }
  #g.busy { color: #4a9d6e; cursor: default; }
  #g.busy svg { display: none; }
  #g.busy::after {
    content: ""; width: 13px; height: 13px; border-radius: 50%;
    border: 2px solid currentColor; border-top-color: transparent;
    animation: rsn-spin .7s linear infinite;
  }
  @keyframes rsn-spin { to { transform: rotate(360deg); } }
  #p {
    position: fixed; z-index: 2147483647; width: 264px;
    background: #16181d; color: #e8eaee; border: 1px solid rgba(255,255,255,.09);
    border-radius: 12px; padding: 13px 14px; box-shadow: 0 10px 34px rgba(0,0,0,.4);
    font: 400 12.5px/1.5 system-ui, -apple-system, sans-serif;
    animation: rsn-pop .16s ease-out;
  }
  /* Entrance replays on every unhide (display:none -> block restarts it). translateY only:
     a scale would shrink the rect placePopover measures mid-animation and misplace it. */
  @keyframes rsn-pop { from { opacity: 0; transform: translateY(4px); } }
  @media (prefers-reduced-motion: reduce) { #p { animation: none; } }
  #p[hidden] { display: none; }
  #p h1 { font-size: 13px; font-weight: 600; margin: 0 0 2px; display: flex; align-items: center; gap: 6px; }
  #p h1 svg { width: 13px; height: 13px; flex: none; }
  #p h1.on { color: #b9e6cd; }
  #p h1.locked, #p h1.plain-once { color: #ecd9a8; }
  #p p { margin: 4px 0 0; color: #9aa3b2; }
  #p button {
    display: block; width: 100%; margin-top: 9px; padding: 7px 10px;
    border-radius: 8px; border: 1px solid rgba(255,255,255,.1);
    background: rgba(255,255,255,.05); color: #e8eaee;
    font: 600 12.5px system-ui, -apple-system, sans-serif; cursor: pointer;
  }
  #p button:hover { background: rgba(255,255,255,.1); }
  /* The product CTA — the site's glossy coral, verbatim from popup.html .btn.primary
     (one soft top light, one crisp edge, coral bloom below). */
  #p button.primary {
    background: linear-gradient(180deg, color-mix(in srgb, #ff5f52 86%, #ffffff), #ff5f52 62%);
    border-color: color-mix(in srgb, #ff5f52 80%, #10154d);
    color: #ffffff;
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,.32),
      0 8px 22px -8px rgba(255,95,82,.55),
      0 2px 6px -2px rgba(255,95,82,.38);
  }
  #p button.primary:hover {
    background: linear-gradient(180deg, color-mix(in srgb, #ff5f52 86%, #ffffff), #ff5f52 62%);
    filter: brightness(1.06);
  }
  #p button.quiet { color: #9aa3b2; font-weight: 500; }
`;

const TITLE: Record<string, string> = {
  unknown: 'Ekko is still identifying this chat — click for details',
  off: 'This chat is not encrypted — click for options',
  'off offer': 'You can chat privately here — click to set it up',
  on: 'Encrypted with Ekko — click for options',
  'plain-once': 'Next message will be sent unencrypted — click for options',
  locked: 'Ekko is locked — sending here is paused',
  busy: 'Encrypting…',
};

export class ComposerGlyph {
  private host: HTMLElement;
  private g: HTMLButtonElement;
  private w: HTMLButtonElement;
  private pl: HTMLElement;
  private p: HTMLElement;
  private state: ChatState = { kind: 'hidden' };
  private actions: ChatActions | null = null;
  private track: () => void = () => {};
  private timer: ReturnType<typeof setInterval> | undefined;
  private menu: 'state' | 'power' = 'state';
  private powerHide: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private anchor: () => HTMLElement | null,
    private platformLabel: string,
    private platform: string,
    private maxMessageLen: number,
  ) {
    this.host = document.createElement('div');
    this.host.id = 'rsn-glyph';
    const root = this.host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style><div id="pl"></div><button id="w" type="button">${ICON_POWER}</button><button id="g" type="button"></button><div id="p" hidden></div>`;
    this.g = root.getElementById('g') as HTMLButtonElement;
    this.w = root.getElementById('w') as HTMLButtonElement;
    this.pl = root.getElementById('pl') as HTMLElement;
    this.p = root.getElementById('p') as HTMLElement;
    document.documentElement.appendChild(this.host);

    // The power reveal (Grammarly's move): pointer or focus on either circle shows it;
    // leaving both retracts it after a beat, unless its menu is open.
    this.w.title = `Turn off Ekko on ${this.platformLabel}…`;
    this.w.setAttribute('aria-label', this.w.title);
    for (const el of [this.g, this.w]) {
      el.addEventListener('mouseenter', () => this.showPower());
      el.addEventListener('mouseleave', () => this.hidePower());
      el.addEventListener('focus', () => this.showPower());
      el.addEventListener('blur', () => this.hidePower());
    }
    this.w.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.menu = 'power';
      if (this.p.hidden) this.openPopover();
      else this.renderPopover();
    });

    this.g.setAttribute('aria-haspopup', 'dialog');
    this.g.setAttribute('aria-expanded', 'false');
    this.g.setAttribute('aria-controls', 'p');
    this.p.setAttribute('role', 'dialog');
    this.p.setAttribute('aria-label', 'Ekko chat controls');
    this.g.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.state.kind === 'busy') return;
      const wasPower = this.menu === 'power' && !this.p.hidden;
      this.menu = 'state';
      if (this.p.hidden) this.openPopover();
      else if (wasPower) this.renderPopover(); // flip an open power menu back to chat state
      else this.closePopover();
    });
    // Click-away closes; composedPath sees through our own shadow root.
    document.addEventListener('click', (e) => {
      if (!this.p.hidden && !e.composedPath().includes(this.host)) this.closePopover();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (!this.p.hidden && (e as KeyboardEvent).key === 'Escape') {
        e.stopPropagation(); // the Escape was for us, not for Instagram
        this.closePopover();
        this.g.focus();
      }
    }, true);
    // rAF-throttled tracking: scroll fires per-frame in capture and composer() forces
    // layout, so never more than one reposition per frame.
    let queued = false;
    this.track = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        this.reposition();
      });
    };
    window.addEventListener('scroll', this.track, true);
    window.addEventListener('resize', this.track, true);
    this.timer = setInterval(this.track, 350); // belt-and-braces: the SPA replaces the composer node freely
  }

  private showPower(): void {
    clearTimeout(this.powerHide);
    if (!this.g.classList.contains('shown')) return;
    for (const el of [this.w, this.pl]) el.classList.add('out');
    requestAnimationFrame(() => {
      if (!this.w.classList.contains('out')) return;
      for (const el of [this.w, this.pl]) el.classList.add('in');
    });
  }

  private hidePower(): void {
    clearTimeout(this.powerHide);
    this.powerHide = setTimeout(() => {
      if (this.menu === 'power' && !this.p.hidden) return; // its menu is open — stay
      for (const el of [this.w, this.pl]) el.classList.remove('in');
      setTimeout(() => {
        if (this.w.classList.contains('in')) return;
        for (const el of [this.w, this.pl]) el.classList.remove('out');
      }, 160);
    }, 300);
  }

  // The power menu's actions. Turning Ekko off here downgrades every send on this platform
  // to an ordinary plain message (linked chats included) — the menu copy says so, and the
  // confirming toast names the road back, because the button it lived on is about to vanish.
  private async powerOff(scope: 'session' | 'forever'): Promise<void> {
    const res = await (scope === 'session'
      ? send({ type: 'setSiteSession', platform: this.platform, enabled: false })
      : send({ type: 'setSite', platform: this.platform, enabled: false }));
    if (res.error) {
      toast('Ekko couldn’t turn itself off — reload the page and try again.');
      return;
    }
    toast(
      scope === 'session'
        ? `Ekko is off on ${this.platformLabel} until you close the browser. The Ekko icon in your toolbar brings it back sooner.`
        : `Ekko is off on ${this.platformLabel}. Turn it back on anytime from the Ekko icon in your toolbar.`,
    );
  }

  private openSeal(): void {
    openSealOverlay(composerTarget(this.anchor, this.platformLabel, this.maxMessageLen));
  }

  // Context-death teardown (boot's orphan watchdog): stop the recurring reposition work
  // and take the UI out of the page. The popover's document listeners stay registered but
  // are inert once the host is gone (guarded by p.hidden).
  destroy(): void {
    clearInterval(this.timer);
    clearTimeout(this.powerHide);
    window.removeEventListener('scroll', this.track, true);
    window.removeEventListener('resize', this.track, true);
    this.closePopover();
    this.host.remove();
  }

  update(state: ChatState, actions: ChatActions): void {
    this.actions = actions;
    // Cheap idempotence: the Controller calls this on every scan tick; identical state
    // must not churn the DOM (and must not close/redraw an open popover). Field-wise
    // compare — this runs continuously, so no per-call serialization garbage.
    if (chatStateEquals(state, this.state)) {
      this.reposition();
      return;
    }
    const prevClass = this.stateClass();
    this.state = state;
    const kind = this.stateClass();
    this.g.className = kind === 'hidden' ? '' : `shown ${kind}`;
    this.g.innerHTML = kind === 'off' || kind === 'plain-once' ? ICON_UNLOCKED : ICON_LOCK;
    this.g.title = TITLE[kind] ?? '';
    this.g.setAttribute('aria-label', this.g.title);
    // A KIND change closes an open popover instead of live-swapping its buttons: 'unknown'
    // and 'off' resolve spontaneously (header renders, invite arrives), and a re-render
    // under the cursor would let a click aimed at "Check again" land on "Send next message
    // unencrypted" or an invite accept. Same-kind field updates still refresh in place.
    if (kind === 'hidden' || kind === 'busy' || kind !== prevClass) this.closePopover();
    else if (!this.p.hidden) this.renderPopover();
    this.reposition();
  }

  private closePopover(): void {
    this.p.hidden = true;
    this.g.setAttribute('aria-expanded', 'false');
  }

  private stateClass(): string {
    const s = this.state;
    if (s.kind === 'on' && s.plainOnce) return 'plain-once';
    // A single actionable offer (peer on Ekko, or a received invite/handshake) turns the
    // idle glyph into a quiet accent beacon — the one moment it asks for attention.
    if (s.kind === 'off' && (s.onEkko || s.invite === 'ready')) return 'off offer';
    return s.kind;
  }

  private hidePair(): void {
    this.g.classList.remove('shown');
    for (const el of [this.w, this.pl]) el.classList.remove('in', 'out');
  }

  private reposition(): void {
    if (this.stateClass() === 'hidden') {
      this.hidePair();
      return;
    }
    const a = this.anchor();
    const r = a?.getBoundingClientRect();
    if (!a || !r || r.width === 0) {
      this.hidePair();
      this.closePopover();
      return;
    }
    // Occlusion probe: if something that is neither the composer's subtree nor its
    // ancestor sits on top of the composer's center (an Instagram modal/backdrop), the
    // glyph must not float above it.
    const probe = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (probe && !a.contains(probe) && !probe.contains(a)) {
      this.hidePair();
      this.closePopover();
      return;
    }
    this.g.classList.add('shown');
    const top = r.top + r.height / 2 - 12;
    this.g.style.top = `${top}px`;
    this.w.style.top = `${top}px`;
    // Sit inside the trailing edge — the side where text ENDS, so it never covers the
    // first characters in RTL layouts. The power circle slides out on the far side of the
    // glyph, one hairline away, and the pill hugs the pair (3px pad, 24+1+24 wide).
    const rtl = getComputedStyle(a).direction === 'rtl';
    const gLeft = rtl ? r.left + 6 : r.right - 30;
    const wLeft = rtl ? gLeft + 25 : gLeft - 25;
    this.g.style.left = `${gLeft}px`;
    this.w.style.left = `${wLeft}px`;
    this.pl.style.left = `${Math.min(gLeft, wLeft) - 3}px`;
    this.pl.style.top = `${top - 3}px`;
    this.pl.style.width = '55px';
    if (!this.p.hidden) this.placePopover();
  }

  private placePopover(): void {
    const g = this.g.getBoundingClientRect();
    const p = this.p.getBoundingClientRect();
    this.p.style.left = `${Math.max(8, Math.min(g.right - p.width, window.innerWidth - p.width - 8))}px`;
    this.p.style.top = `${Math.max(8, g.top - p.height - 10)}px`;
  }

  private openPopover(): void {
    this.renderPopover();
    this.p.hidden = false;
    this.g.setAttribute('aria-expanded', 'true');
    this.placePopover();
    // Never hand focus to a destructive default: the power menu opens with focus on its
    // SAFE action ("No, keep it on") — otherwise one absent-minded Enter right after
    // opening it turns Ekko off for the whole platform and the glyph vanishes everywhere.
    const first =
      this.menu === 'power'
        ? (this.p.querySelector<HTMLButtonElement>('button.quiet') ?? this.p.querySelector<HTMLButtonElement>('button'))
        : this.p.querySelector<HTMLButtonElement>('button');
    first?.focus();
  }

  // All content is built with textContent — contact labels are user data, never markup.
  private renderPopover(): void {
    const s = this.state;
    const act = this.actions;
    this.p.replaceChildren();
    const h = (cls: string, icon: string, text: string) => {
      const el = document.createElement('h1');
      el.className = cls;
      el.innerHTML = icon; // constant, trusted markup
      el.appendChild(document.createTextNode(text));
      this.p.appendChild(el);
    };
    const para = (text: string) => {
      const el = document.createElement('p');
      el.textContent = text;
      this.p.appendChild(el);
    };
    const btn = (cls: string, text: string, fn: () => void) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = cls;
      el.textContent = text;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.p.hidden = true;
        this.g.setAttribute('aria-expanded', 'false');
        this.g.focus();
        fn();
      });
      this.p.appendChild(el);
    };

    // The power menu (the ⏻ circle, or the quiet row below on touch). Its own render:
    // turning Ekko off is about the PLATFORM, not the open chat, and the stakes are worth
    // one honest sentence — an off Ekko sends plaintext even in chats you encrypted.
    if (this.menu === 'power') {
      h('', ICON_POWER, `Turn off Ekko on ${this.platformLabel}?`);
      para(`The button disappears and nothing encrypts or decrypts. Messages you send while it's off are ordinary ${this.platformLabel} messages, even in chats you encrypted.`);
      btn('', 'Off for this session', () => void this.powerOff('session'));
      btn('', 'Off from now on', () => void this.powerOff('forever'));
      btn('quiet', 'No, keep it on', () => this.hidePower());
      para('The Ekko icon in your browser toolbar turns it back on anytime.');
      return;
    }

    if (s.kind === 'off') {
      if (s.invite === 'ready' && s.inviteKind === 'handshake') {
        h('on', ICON_LOCK, s.peer ? `${s.peer} wants to chat privately` : 'Private chat request');
        para('They set up end-to-end encryption for this chat. Accept to read and reply sealed.');
        btn('primary', 'Accept encrypted chat', () => act?.acceptInvite());
      } else if (s.invite === 'ready') {
        h('', ICON_UNLOCKED, 'Not encrypted');
        para('This chat contains one Ekko invite. Only add it if you trust the sender.');
        btn('primary', 'Add invite and encrypt this chat', () => act?.acceptInvite());
      } else if (s.invite === 'ambiguous') {
        h('', ICON_UNLOCKED, 'Not encrypted');
        para('This chat contains different Ekko invites. Open Ekko and paste the one you trust.');
      } else if (s.suggestLabel && s.onEkko) {
        h('on', ICON_LOCK, `${s.suggestLabel} is on Ekko`);
        para('You can seal messages here end-to-end, post-quantum. They decrypt automatically on their side.');
        btn('primary', `Encrypt with ${s.suggestLabel}`, () => act?.enable());
      } else if (s.suggestLabel) {
        h('', ICON_UNLOCKED, 'Not encrypted');
        para(`Messages in this chat are ordinary ${this.platformLabel} messages.`);
        btn('primary', `Encrypt with ${s.suggestLabel}`, () => act?.enable());
      } else {
        // The growth moment: a 1:1 with someone who isn't on Ekko (or isn't connected yet)
        // used to dead-end at advice. Hand over the invite instead.
        h('', ICON_UNLOCKED, 'Not encrypted');
        para(`Messages in this chat are ordinary ${this.platformLabel} messages.`);
        para('Once you connect on Ekko, this chat encrypts automatically.');
        btn('primary', 'Copy an invite to send them', () => act?.invitePeer());
        // Already hold their key from somewhere else? The manual road is one quiet row —
        // deliberate, unbound, double-checked in its own flow.
        btn('quiet', 'Seal a message for a contact…', () => this.openSeal());
      }
    } else if (s.kind === 'on' && s.plainOnce) {
      h('plain-once', ICON_UNLOCKED, 'Next message goes unencrypted');
      para(`After it sends, this chat returns to encrypting for ${s.label}.`);
      btn('primary', 'Cancel — keep encrypting', () => act?.plainOnce(false));
    } else if (s.kind === 'on') {
      h('on', ICON_LOCK, `Encrypted with ${s.label}`);
      para('End-to-end, post-quantum. Only the two of you can read these messages.');
      btn('quiet', 'Send next message unencrypted', () => act?.plainOnce(true));
      btn('quiet', 'Turn off for this chat', () => act?.disable());
    } else if (s.kind === 'locked') {
      h('locked', ICON_LOCK, 'Ekko is locked');
      para('This chat encrypts messages, so sending is paused until you unlock.');
      btn('primary', 'Unlock Ekko', () => act?.unlock());
    } else if (s.kind === 'unknown') {
      h('', ICON_LOCK, 'Identifying this chat…');
      para(`Ekko can't confirm this is a private 1:1 ${this.platformLabel} chat yet, so sending here is paused.`);
      para('This can happen while the page is still loading, or if this is a group chat — Ekko only encrypts 1:1 chats. If a private chat never resolves, turn on the debug overlay in Ekko’s Settings and report what it shows.');
      btn('', 'Check again', () => act?.retry());
      // The chat may never resolve — but the user still knows who they're writing to.
      // Manual seal works without recognizing the surface; its own flow owns the checks.
      btn('quiet', 'Seal a message for a contact…', () => this.openSeal());
    }

    // Touch has no hover, so the ⏻ circle never appears there — only THEN does the
    // platform-off door live in this popover. Everywhere else the power circle owns it
    // (owner call: one switch, one place; keyboards reach the circle by Tab).
    if (matchMedia('(hover: none)').matches) {
      btn('quiet', `Turn off Ekko on ${this.platformLabel}…`, () => {
        this.menu = 'power';
        this.openPopover();
      });
    }
  }

  // Debug overlay only: is the button actually rendered right now? State says what it
  // SHOULD show; this says whether anchoring/occlusion let it.
  visible(): boolean {
    return this.g.classList.contains('shown');
  }
}
