// Ekko popup — consumer UI. Four tabs (Home / Contacts / Identity / Settings) on a
// MetaMask-style shell. All crypto lives in the background service worker; this is view
// logic only. QR rendering loads lazily so the popup opens instantly.
import { send } from '../core/rpc.js';
import { generatePassphrase } from '../core/backup.js';
import type { ContactView } from '../core/rpc.js';
import { classify, TOKEN_RE, IG_MAX_MESSAGE_LEN } from '../core/wire.js';
import { splitMessage, randomChunkId, Reassembler } from '../core/chunk.js';
import { MANUAL_PLATFORMS, manualThreadId, type ManualPlatformId } from '../core/thread.js';
import { decodeEkkoQr, IDENTITY_QR_OPTIONS, qrScanningSupported, type QrDecodeResult } from './qr.js';
import { inviteMessage } from '../core/growth.js';
import { humanError } from '../core/errors.js';
import { BRANDS, brandSvg, brandStyle } from './brands.js';

const app = document.getElementById('app')!;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll(sel)) as T[];

type Tab = 'home' | 'contacts' | 'identity' | 'settings';
let tab: Tab = 'home';

// Ekko handle: mirrors USERNAME_RE in background.ts. A directory handle (@you) is optional
// discovery — friends can add you by name instead of a 1,600-char invite.
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
function handleClaimError(code: string): string {
  return (
    {
      'username-taken': 'That handle is taken. Pick another from the Identity tab.',
      'username-exists': 'You already have a handle.',
      'bad-username': 'That handle isn’t valid (3–20 letters, numbers or _).',
      'directory-insecure': 'Couldn’t reach the directory securely — try claiming later.',
      'directory-unreachable': 'The directory was unreachable — try claiming later.',
      'directory-error': 'The directory had a problem — try claiming later.',
    }[code] ?? 'Couldn’t claim that handle — try again from the Identity tab.'
  );
}

const I = {
  // Balanced Packet E. Must stay in sync with the site and onboarding.ts.
  logo: '<svg viewBox="0 0 48 48" fill="currentColor"><rect x="5" y="4" width="9" height="40" rx="4.5"/><rect x="17" y="4" width="27" height="9" rx="4.5"/><rect x="17" y="19.5" width="19" height="9" rx="4.5"/><rect x="17" y="35" width="27" height="9" rx="4.5"/><circle cx="42" cy="24" r="3"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 11 12 4l8 7"/><path d="M6 10v9h12v-9"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6"/><path d="M18 19a5.5 5.5 0 0 0-3-4.9"/></svg>',
  id: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="8.5" cy="11" r="2.2"/><path d="M5.5 16.5a3 3 0 0 1 6 0"/><path d="M14.5 9.5h4M14.5 13h4"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M4.2 7l2.6 1.5M17.2 15.5l2.6 1.5M4.2 17l2.6-1.5M17.2 8.5l2.6-1.5"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="10.5" width="14" height="9.5" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m4.5 12.5 5 5 10-11"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  scan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 4H5a1 1 0 0 0-1 1v3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M9 9h2v2H9zM14 9h1v1h-1zM9 14h1v1H9zM13 13h2v2h-2z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M7 7l1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m14.5 5.5 4 4L8 20H4v-4Z"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="12" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="18" cy="18" r="2.4"/><path d="M8.1 10.9 15.9 7.1M8.1 13.1l7.8 3.8"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3.5 5 6.5v5c0 4.5 3 7.8 7 9 4-1.2 7-4.5 7-9v-5Z"/></svg>',
  device: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M11 17.5h2"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4Z"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l16 16"/><path d="M9.9 5.2A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a15 15 0 0 1-3 3.6M6 6.6A15 15 0 0 0 2 12s3.5 7 10 7a9.5 9.5 0 0 0 3.4-.6"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="15" r="4"/><path d="M11 12 20 3M17 6l2 2M14 9l2 2"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9.5 14.5 14.5 9.5"/><path d="M12.5 7 14 5.5a3.5 3.5 0 0 1 5 5L17.5 12M11.5 17 10 18.5a3.5 3.5 0 0 1-5-5L6.5 12"/></svg>',
};

// ————— small helpers —————

const initials = (label: string) =>
  label.split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase() || '?';
const AV = ['#ff5f52', '#57c088', '#d9a13d', '#5b9df0', '#5bb8c4', '#b98cf0'];
const avatarColor = (seed: string) => {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AV[h % AV.length]!;
};

// Two-tap destructive actions: the first click arms the button (its label becomes the
// question), the second within 4s commits, anything else disarms. Replaces native
// confirm() dialogs, which read as the OS interrupting a consumer app.
function armed(btn: HTMLElement, question: string, fn: () => void | Promise<void>): void {
  btn.addEventListener('click', () => {
    if (btn.dataset.armed) {
      delete btn.dataset.armed;
      return void fn();
    }
    const orig = btn.innerHTML;
    btn.dataset.armed = '1';
    btn.classList.add('armed');
    btn.innerHTML = `<span>${esc(question)}</span>`;
    setTimeout(() => {
      if (!btn.isConnected || !btn.dataset.armed) return;
      delete btn.dataset.armed;
      btn.classList.remove('armed');
      btn.innerHTML = orig;
    }, 4000);
  });
}

function copyFeedback(btn: HTMLElement, text: string): void {
  void navigator.clipboard.writeText(text).then(() => {
    const orig = btn.innerHTML;
    btn.innerHTML = `${I.check}<span>Copied</span>`;
    setTimeout(() => (btn.innerHTML = orig), 1400);
  });
}

async function broadcastRescan(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(tabs.filter((t) => t.id).map((t) => chrome.tabs.sendMessage(t.id!, { type: 'rescan' })));
  } catch {
    /* cosmetic */
  }
}

// password field with a show/hide eye
function pwField(id: string, placeholder: string, autocomplete = 'current-password'): string {
  return `<div class="pw">
    <input id="${id}" name="${id}" type="password" aria-label="${placeholder}" placeholder="${placeholder}" autocomplete="${autocomplete}" spellcheck="false" />
    <button class="eye" data-eye="${id}" type="button" aria-label="Show password">${I.eye}</button>
  </div>`;
}
function wireEyes(root: ParentNode = document): void {
  for (const b of $$('[data-eye]', root))
    b.addEventListener('click', () => {
      const inp = document.getElementById(b.dataset.eye!) as HTMLInputElement;
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      b.innerHTML = show ? I.eyeOff : I.eye;
    });
}

function setBusy(btn: HTMLButtonElement, on: boolean): void {
  btn.disabled = on;
  btn.toggleAttribute('aria-busy', on);
}

async function openOnboarding(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  window.close();
}

// ————— top-level router —————

async function render(): Promise<void> {
  const s = await send({ type: 'status' });
  if (s.error === 'unreachable') {
    app.innerHTML = `<main><div class="card center"><p class="muted">Ekko couldn’t reach its background service. Close and reopen this window.</p></div></main>`;
    return;
  }
  if (s.state === 'no-vault') return welcome();
  if (s.state === 'locked') return unlock();
  return shell();
}

// ————— full-screen (no tabs): welcome / create / unlock —————

function welcome(): void {
  app.innerHTML = `
    <main class="fade">
      <div class="hero">
        <span class="logo">${I.logo}</span>
        <h1>Welcome to Ekko</h1>
        <p>Private, post-quantum encrypted messaging on top of the apps you already use.</p>
      </div>
      <div class="card">
        <div class="feature">${I.device}<div><div class="t">Your private keys stay on this device</div><div class="d">The optional directory receives public keys only. It can never decrypt your messages.</div></div></div>
        <div class="feature">${I.shield}<div><div class="t">Post-quantum encryption</div><div class="d">Protected even against future quantum computers.</div></div></div>
        <div class="feature">${I.chat}<div><div class="t">Works inside your DMs</div><div class="d">Encrypts as you send, decrypts as you read.</div></div></div>
      </div>
      <button id="start" class="btn primary block">Get started</button>
      <p class="hint center">Takes about 30 seconds · no sign-up</p>
    </main>`;
  $('#start').addEventListener('click', () => void openOnboarding());
}

async function unlock(): Promise<void> {
  const settings = await send({ type: 'getSettings' });
  app.innerHTML = `
    <main class="fade">
      <div class="hero compact"><span class="logo">${I.logo}</span><h1>Welcome back</h1></div>
      <div class="card">
        <h2>Unlock</h2>
        ${pwField('p', 'Password')}
        <label class="row" style="margin-top:8px;gap:8px;align-items:flex-start">
          <input type="checkbox" id="keepUnlocked" style="margin-top:3px" ${settings.keepUnlocked ? 'checked' : ''} />
          <span class="muted">Keep me unlocked on this device. Skips this screen after a browser restart; your computer's login becomes the lock. Leave off on a shared computer.</span>
        </label>
        <div id="msg" class="msg err" role="alert"></div>
        <button id="go" class="btn primary block" style="margin-top:8px">Unlock</button>
      </div>
      <details class="adv"><summary style="text-align:center">Restore from a backup file</summary>
        <div class="card" style="margin-top:8px">${backupImportHtml()}</div>
      </details>
    </main>`;
  wireEyes();
  const go = async () => {
    const res = await send({
      type: 'unlock',
      passphrase: $<HTMLInputElement>('#p').value,
      keepUnlocked: $<HTMLInputElement>('#keepUnlocked').checked,
    });
    if (res.error) return void ($('#msg').textContent = res.error === 'wrong-passphrase' ? 'Wrong password — try again.' : humanError(res.error));
    await broadcastRescan();
    await shell();
  };
  $('#go').addEventListener('click', go);
  $<HTMLInputElement>('#p').addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && go());
  $<HTMLInputElement>('#p').focus();
  wireBackupImport();
}

// ————— app shell with tabs —————

async function shell(): Promise<void> {
  const nav = (id: Tab, icon: string, label: string) =>
    `<button data-tab="${id}" class="${tab === id ? 'active' : ''}">${icon}<span>${label}</span></button>`;
  app.innerHTML = `
    <div class="appbar">
      <span class="logo">${I.logo}</span><span class="name">ekko</span>
      <span class="grow"></span><span class="status-dot on" title="Protected"></span>
    </div>
    <main id="main"></main>
    <div class="tabbar">
      ${nav('home', I.home, 'Home')}${nav('contacts', I.people, 'Contacts')}${nav('identity', I.id, 'Identity')}${nav('settings', I.gear, 'Settings')}
    </div>`;
  for (const b of $$('[data-tab]'))
    b.addEventListener('click', () => {
      tab = b.dataset.tab as Tab;
      for (const x of $$('[data-tab]')) x.classList.toggle('active', x === b);
      void renderTab();
    });
  await renderTab();
}

async function renderTab(): Promise<void> {
  const main = $('#main');
  main.className = 'fade';
  if (tab === 'home') return homeTab(main);
  if (tab === 'contacts') return contactsTab(main);
  if (tab === 'identity') return identityTab(main);
  return settingsTab(main);
}

// ————— HOME: this-chat + per-app toggles —————

// Visual identity (name, colour, mark) comes from BRANDS; `name` here only overrides it
// where the Home row means the WEB surface ("WhatsApp Web"), not the brand.
type App = { id: string; name?: string; live: boolean; status: string };

// Home-tab site toggles. Deliberately NOT the same registry as core/thread.ts
// MANUAL_PLATFORMS: this lists every site Ekko may run on (including ones with no manual
// copy/paste target, like Messenger), that one lists popup manual-tool destinations.
// When a platform ships an adapter, update BOTH if it should also gain a manual context.
const APPS: App[] = [
  { id: 'instagram', live: true, status: 'Active' },
  { id: 'whatsapp', name: 'WhatsApp Web', live: true, status: 'Beta' },
  { id: 'telegram', name: 'Telegram Web', live: true, status: 'Beta' },
  { id: 'messenger', live: true, status: 'Beta' },
  { id: 'x', live: false, status: 'Planned' },
];

// No per-chat card here anymore: chats bind AUTOMATICALLY when a contact's account-linked
// handle matches, and the glyph beside the message box owns per-chat state and the off
// switch. The popup manages people (Contacts) and apps — never individual conversations.
async function homeTab(main: HTMLElement): Promise<void> {
  const settings = await send({ type: 'getSettings' });
  const sites = settings.sites ?? {};
  const sessionOff = new Set(settings.sessionOff ?? []);

  main.innerHTML = `
    <div class="card tight">
      <div style="padding:10px 0 4px"><h2 style="margin:0">Apps</h2></div>
      ${APPS.map((a) => appRow(a, sites[a.id] ?? true, sessionOff.has(a.id))).join('')}
    </div>
    <p class="hint center">Turn Ekko on or off per app. Chats with your connections encrypt automatically.</p>`;

  for (const t of $$<HTMLInputElement>('[data-site]'))
    t.addEventListener('change', async () => {
      // Turning a platform ON also lifts an in-page "off for this session" pause — the
      // background clears it in the same setSite call, so this toggle is the master switch.
      await send({ type: 'setSite', platform: t.dataset.site!, enabled: t.checked });
      await homeTab(main);
    });
}

function appRow(a: App, on: boolean, paused = false): string {
  const b = BRANDS[a.id]!;
  const name = a.name ?? b.name;
  if (paused) a = { ...a, status: 'Paused this session' }; // set from the in-page power button
  const checked = a.live && on && !paused; // planned apps read as off, not enabled-looking
  return `<div class="listrow">
    <span class="appicon" style="${brandStyle(b)}">${brandSvg(b)}</span>
    <div class="grow"><div class="strong">${name}</div><div class="muted">${a.status}</div></div>
    <label class="switch"><input type="checkbox" data-site="${a.id}" aria-label="Enable Ekko on ${name}" ${checked ? 'checked' : ''} ${a.live ? '' : 'disabled'} /><span class="track"></span></label>
  </div>`;
}

// ————— CONTACTS: search / add / rename / remove / verify —————

// Incoming connection requests, from the sync that just ran. Accepting is the consent
// moment — it is what reveals their key and staged session — so it must be a visible,
// explicit choice here, not something a sync does behind the user's back.
function renderRequests(main: HTMLElement, requests: { id: string; handle: string }[]): void {
  const slot = document.getElementById('reqs');
  if (!slot) return;
  if (!requests.length) {
    slot.innerHTML = '';
    return;
  }
  slot.innerHTML = `<div class="card">
    <h2>Connection requests</h2>
    ${requests
      .map(
        (r) => `<div class="row" style="margin-top:8px"><div class="grow strong">@${esc(r.handle)}</div>
      <button class="btn" data-decline="${r.id}">Decline</button>
      <button class="btn primary" data-accept="${r.id}" data-handle="${esc(r.handle)}">Accept</button></div>`,
      )
      .join('')}
  </div>`;
  for (const b of Array.from(slot.querySelectorAll<HTMLButtonElement>('[data-accept]')))
    b.addEventListener('click', async () => {
      setBusy(b, true);
      const done = await send({ type: 'acctAccept', connectionId: b.dataset.accept! });
      void broadcastRescan(); // their staged session may have just become readable
      void contactsTab(
        main,
        done.error
          ? 'Could not accept the request — try again.'
          : `You are now connected to @${b.dataset.handle}. Chats with them encrypt automatically.`,
      );
    });
  for (const b of Array.from(slot.querySelectorAll<HTMLButtonElement>('[data-decline]')))
    b.addEventListener('click', async () => {
      setBusy(b, true);
      await send({ type: 'acctDecline', connectionId: b.dataset.decline! });
      void contactsTab(main);
    });
}

let contactQuery = '';

async function contactsTab(main: HTMLElement, notice = ''): Promise<void> {
  const contacts = (await send({ type: 'contacts' })).contacts ?? [];
  // The empty state is the growth moment: a new user's friends don't have Ekko yet, and
  // "share your invite from the Identity tab" was homework. Hand them the message instead.
  const myName = contacts.length === 0 ? (await send({ type: 'invite' })).username : undefined;
  if (contacts.length <= 4) contactQuery = ''; // no search box below 5 — don't strand a stale filter
  const q = contactQuery.toLowerCase();
  const shown = q ? contacts.filter((c) => c.label.toLowerCase().includes(q)) : contacts;
  main.innerHTML = `
    <div id="reqs"></div>
    <div class="card">
      <h2>Add someone</h2>
      <p class="muted">If they have an Ekko handle, that is all you need.</p>
      <div class="row" style="margin-top:8px">
        <div class="handle-in grow"><span class="at">@</span><input id="handleIn" name="contact-handle" aria-label="Their Ekko handle" placeholder="their-handle" autocomplete="off" spellcheck="false" maxlength="20" /></div>
        <button id="lookupBtn" class="btn primary">Look up</button>
      </div>
      <div id="addMsg" class="msg err" role="alert"></div>
      <div id="preview" role="region" aria-live="polite"></div>
      <div id="syncMsg" class="msg ok" role="status" aria-live="polite">${esc(notice)}</div>

      <details class="adv" style="margin-top:10px">
        <summary>Other ways to add</summary>
        <div style="margin-top:10px">
          <button id="scanQr" type="button" class="btn block icon" aria-describedby="qrTrust" hidden>${I.scan}<span>Import QR image…</span></button>
          <input id="qrFile" type="file" accept="image/*" hidden />
          <p id="qrTrust" class="hint">A QR code identifies a key, not a person — only scan codes you got from them directly.</p>
          <div id="qrStatus" class="msg ok" role="status" aria-live="polite"></div>
          <div id="qrError" class="msg err" role="alert"></div>
          <label class="field" for="inviteIn">Ekko invite</label>
          <textarea id="inviteIn" name="contact-invite" aria-label="Ekko invite" placeholder="Paste their invite (EKK1I:…)" spellcheck="false"></textarea>
          <label class="field" for="nameIn">Contact name (optional)</label>
          <input id="nameIn" name="contact-name" placeholder="e.g. Maya" />
          <button id="add" type="button" class="btn icon block" style="margin-top:6px">${I.plus}<span>Add pasted invite</span></button>
        </div>
      </details>
    </div>
    <div class="card">
      <div class="row" style="margin-bottom:8px"><h2 style="margin:0" class="grow">Contacts${contacts.length ? ` · ${contacts.length}` : ''}</h2></div>
      ${contacts.length > 4 ? `<div class="search">${I.search}<input id="q" type="search" name="contact-search" aria-label="Search contacts" placeholder="Search…" autocomplete="off" value="${esc(contactQuery)}" /></div>` : ''}
      <div id="list">${
        shown.map(contactRow).join('') ||
        (contacts.length
          ? `<p class="muted">No matches.</p>`
          : `<p class="muted">No one here yet — Ekko works when a friend has it too. Send this to the person you text most:</p>
             <div class="pitch" style="margin-top:8px">${esc(inviteMessage(myName))}</div>
             <button id="invitePitch" class="btn icon block" style="margin-top:8px">${I.copy}<span>Copy message</span></button>`)
      }</div>
    </div>`;
  $('#invitePitch')?.addEventListener('click', () => copyFeedback($('#invitePitch'), inviteMessage(myName)));

  const add = $<HTMLButtonElement>('#add');
  add.addEventListener('click', async () => {
    setBusy(add, true);
    await addContact($<HTMLTextAreaElement>('#inviteIn').value, $<HTMLInputElement>('#nameIn').value);
    if (add.isConnected) setBusy(add, false);
  });
  $<HTMLInputElement>('#nameIn').addEventListener('keydown', (e) => e.key === 'Enter' && add.click());
  $<HTMLTextAreaElement>('#inviteIn').addEventListener(
    'keydown',
    (e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && add.click(),
  );
  wireQrImport();
  $('#lookupBtn').addEventListener('click', () => void lookupHandle());
  $<HTMLInputElement>('#handleIn').addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && void lookupHandle());

  // Pick up the key of anyone we have connected to on the account since last time. Fired AFTER the
  // list is on screen, not before it: a network round trip must never be the reason the popup feels
  // slow. If it brings someone new, say so and redraw.
  void send({ type: 'acctSync' }).then((res) => {
    // A sync can change what open pages decrypt, bind, and suggest (new keys, mailbox
    // sessions, freshly linked handles) — and pages cache negative answers (a null
    // suggestion, a pending bubble). One rescan per sync keeps every tab honest.
    if (res.ok) void broadcastRescan();
    if (!main.isConnected) return;
    renderRequests(main, res.requests ?? []);
    const n = res.restoredContacts ?? 0;
    if (n > 0) {
      // Re-render to show the new contacts. Loop-safe: the next sync restores 0 (they're known now).
      void contactsTab(main, `${n} ${n === 1 ? 'person you are' : 'people you are'} connected to can now be encrypted to.`);
      return;
    }
    // Nothing adopted, and no contacts to show — but a connection was skipped for a reason worth
    // saying out loud (the "it's just empty and I don't know why" case). Set it in place, no re-render.
    if (res.skippedSelf && !contacts.length) {
      const el = document.getElementById('syncMsg');
      if (el) {
        el.className = 'msg';
        el.textContent =
          'A connection here shares this browser’s identity key, so it can’t be added — you can’t add yourself. To test encrypting between two accounts, sign each in with a different recovery phrase.';
      }
    }
  });

  const qi = document.getElementById('q') as HTMLInputElement | null;
  qi?.addEventListener('input', () => {
    contactQuery = qi.value;
    const q2 = contactQuery.toLowerCase();
    const sh = q2 ? contacts.filter((c) => c.label.toLowerCase().includes(q2)) : contacts;
    $('#list').innerHTML = sh.map(contactRow).join('') || `<p class="muted">No matches.</p>`;
    wireContactRows(main, contacts);
  });
  wireContactRows(main, contacts);
}

const QR_ERROR: Record<Extract<QrDecodeResult, { error: string }>['error'], string> = {
  unsupported: 'QR import isn’t available in this browser. Paste the invite instead.',
  'too-large': 'That image is too large. Use a screenshot under 16 MB.',
  unreadable: 'We couldn’t open that image. Choose another image or paste the invite.',
  'no-code': 'No QR code found. Choose an image with the whole code in view.',
  'no-invite': 'That QR code isn’t an Ekko invite.',
  'multiple-invites': 'More than one Ekko invite was found. Crop the image to one code and try again.',
};

function wireQrImport(): void {
  const button = $<HTMLButtonElement>('#scanQr');
  const input = $<HTMLInputElement>('#qrFile');
  if (qrScanningSupported()) button.hidden = false;
  button.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = ''; // selecting the same screenshot again must fire change
    if (!file) return;
    const status = $('#qrStatus');
    const error = $('#qrError');
    status.textContent = 'Reading QR image…';
    error.textContent = '';
    $('#addMsg').textContent = '';
    setBusy(button, true);
    const decoded = await decodeEkkoQr(file);
    setBusy(button, false);
    if (!button.isConnected) return;
    if ('error' in decoded) {
      status.textContent = '';
      error.textContent = QR_ERROR[decoded.error];
      (decoded.error === 'unsupported' ? $('#inviteIn') : button).focus();
      return;
    }
    $<HTMLTextAreaElement>('#inviteIn').value = decoded.invite;
    status.textContent = 'Invite found. Add a name if you want, then add this contact.';
    $<HTMLInputElement>('#nameIn').focus();
  });
}

// A contact's linked messenger handles — the "one identity across your apps" view the phone
// already shows. Populated from their account_handles when connections sync (background
// acctSync). Known platforms show their brand mark; an id BRANDS doesn't know yet (a newer
// server than this build) degrades to a neutral dot, never a broken image.
function socialChips(handles?: Record<string, string>): string {
  const entries = Object.entries(handles ?? {}).filter(([, h]) => h);
  if (!entries.length) return '';
  return `<div class="socials">${entries
    .map(([platform, h]) => {
      const b = BRANDS[platform];
      const at = platform === 'whatsapp' ? '' : '@'; // WhatsApp is a phone number, not an @handle
      const mark = b ? `<span class="social-logo" style="${brandStyle(b)}">${brandSvg(b)}</span>` : `<span class="social-dot"></span>`;
      return `<span class="social" title="${esc(b?.name ?? platform)}">${mark}${at}${esc(h)}</span>`;
    })
    .join('')}</div>`;
}

function contactRow(c: ContactView): string {
  return `<div class="listrow" data-fp="${c.fingerprint}">
    <span class="avatar" style="--av:${avatarColor(c.fingerprint)}">${esc(initials(c.label))}</span>
    <div class="grow" style="min-width:0">
      <div class="row"><span class="nm-label">${esc(c.label)}</span></div>
      ${socialChips(c.handles)}
    </div>
    <button class="btn ghost sq" data-apps aria-label="Link apps for ${esc(c.label)}" title="Link their apps">${I.link}</button>
    <button class="btn ghost sq" data-rename aria-label="Rename ${esc(c.label)}" title="Rename">${I.pencil}</button>
    <button class="btn ghost sq danger" data-remove aria-label="Remove ${esc(c.label)}" title="Remove">${I.trash}</button>
  </div>`;
}

function wireContactRows(main: HTMLElement, contacts: ContactView[]): void {
  for (const row of $$('.listrow[data-fp]')) {
    const fp = row.dataset.fp!;
    const rm = $('[data-remove]', row);
    if (rm)
      armed(rm, 'Remove contact?', async () => {
        await send({ type: 'removeContact', fingerprint: fp });
        await broadcastRescan();
        await contactsTab(main);
      });
    $('[data-rename]', row)?.addEventListener('click', () => startRename(row, fp, main));
    $('[data-apps]', row)?.addEventListener('click', () => {
      const c = contacts.find((x) => x.fingerprint === fp);
      if (c) startAppsEdit(row, c, main);
    });
  }
}

// Manually tell Ekko where a contact lives: platform -> handle, the same mapping account
// sync fills in automatically for connections. This is how an off-grid (invite/QR) contact
// gets chat recognition — the glyph can then match the open DM to them by handle instead
// of a mis-hittable display name.
function startAppsEdit(row: HTMLElement, c: ContactView, main: HTMLElement): void {
  if (row.nextElementSibling?.classList.contains('apps-edit')) return; // one editor per row
  const editor = document.createElement('div');
  editor.className = 'apps-edit';
  editor.innerHTML = `
    ${CONNECT_APPS.map((a) => {
      const b = BRANDS[a.id]!;
      return `<div class="listrow">
        <span class="appicon" style="${brandStyle(b)}">${brandSvg(b)}</span>
        <div class="grow" style="min-width:0"><input data-app-in="${a.id}" name="${a.id}-contact-handle" aria-label="${esc(c.label)} on ${b.name}" placeholder="${a.hint}" autocomplete="off" spellcheck="false" maxlength="100" style="margin:0" value="${esc(c.handles?.[a.id] ?? '')}" /></div>
      </div>`;
    }).join('')}
    <p class="hint">Clearing a field removes that link. Apps they linked on their own Ekko account refresh with sync and can reappear.</p>
    <div class="row" style="margin-top:6px">
      <button class="btn primary grow" data-apps-save>Save</button>
      <button class="btn ghost" data-apps-cancel>Cancel</button>
    </div>
    <div class="msg err" data-apps-msg role="alert"></div>`;
  row.after(editor);
  $<HTMLInputElement>('[data-app-in]', editor)?.focus();
  $('[data-apps-cancel]', editor)?.addEventListener('click', () => editor.remove());
  $('[data-apps-save]', editor)?.addEventListener('click', async () => {
    // Start from what the contact already has so platforms this editor doesn't show
    // (e.g. an account-synced discord handle) survive the replace.
    const handles: Record<string, string> = { ...(c.handles ?? {}) };
    for (const a of CONNECT_APPS) {
      const val = $<HTMLInputElement>(`[data-app-in="${a.id}"]`, editor)?.value.trim() ?? '';
      if (val) handles[a.id] = val;
      else delete handles[a.id];
    }
    const btn = $<HTMLButtonElement>('[data-apps-save]', editor);
    setBusy(btn, true);
    const res = await send({ type: 'setContactHandles', fingerprint: c.fingerprint, handles });
    if (res.error) {
      setBusy(btn, false);
      $('[data-apps-msg]', editor).textContent =
        res.error === 'bad-handle' ? 'One of those doesn’t look right — check it.' : humanError(res.error);
      return;
    }
    await broadcastRescan(); // open chats can now recognize (or stop recognizing) this person
    await contactsTab(main);
  });
}

function startRename(row: HTMLElement, fp: string, main: HTMLElement): void {
  const label = $('.nm-label', row);
  const input = document.createElement('input');
  input.value = label.textContent ?? '';
  input.setAttribute('aria-label', 'Contact name');
  input.maxLength = 40;
  input.style.margin = '0';
  label.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save: boolean) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (save && name && name !== label.textContent) await send({ type: 'renameContact', fingerprint: fp, label: name });
    await contactsTab(main);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void finish(true);
    if (e.key === 'Escape') void finish(false);
  });
  input.addEventListener('blur', () => void finish(true));
}

// Add someone by their Ekko @handle, in two acts.
//
// It used to be one: type a handle, press a button, and a key you had never seen was in your
// contacts. Looking somebody up and trusting them are different decisions, so they are now
// different taps. `dirLookup` asks the directory who @maya is and writes nothing; the card it
// renders shows the security code that identifies her key BEFORE you take it, which is the one
// moment that code is genuinely useful. `dirAdd` is still the single audited write.
const dirError = (code: string, handle: string): string =>
  ({
    'not-found': `No one on Ekko has claimed @${handle} yet.`,
    'thats-you': 'That’s your own handle.',
    'bad-username': 'Handle: 3–20 letters, numbers or _.',
    'bad-invite': 'The directory returned an invalid key.',
    'directory-insecure': 'Couldn’t reach the directory securely.',
    'directory-unreachable': 'Couldn’t reach the directory — try again.',
    'directory-error': 'The directory had a problem — try again.',
    locked: 'Ekko is locked.',
  })[code] ?? code;

async function lookupHandle(): Promise<void> {
  const msg = $('#addMsg');
  const box = $('#preview');
  msg.className = 'msg err';
  msg.textContent = '';
  box.innerHTML = '';
  const h = $<HTMLInputElement>('#handleIn').value.trim().replace(/^@/, '').toLowerCase();
  if (!HANDLE_RE.test(h)) return void (msg.textContent = 'Handle: 3–20 letters, numbers or _.');

  const btn = $<HTMLButtonElement>('#lookupBtn');
  setBusy(btn, true);
  const res = await send({ type: 'dirLookup', username: h });
  if (!btn.isConnected) return;
  setBusy(btn, false);
  if (res.error || !res.contact) return void (msg.textContent = dirError(res.error ?? '', h));

  box.innerHTML = previewCard(h, res.contact);
  const addBtn = $<HTMLButtonElement>('#previewAdd');
  addBtn.addEventListener('click', async () => {
    setBusy(addBtn, true);
    const done = await send({ type: 'dirAdd', username: h });
    if (done.error) {
      setBusy(addBtn, false);
      msg.textContent = dirError(done.error, h);
      return;
    }
    await showAddedContact(done.contact);
  });
  addBtn.focus();
}

// The person the directory answered with. This is everything the key directory knows about
// @maya — a key, and the code that names it. It does NOT know her Instagram: platform mappings
// are stored hashed precisely so a handle cannot be turned back into a person's accounts
// (docs/DIRECTORY.md). Where she can be reached is the account's business, and it lives behind
// her consent, on her profile in the app.
function previewCard(handle: string, c: ContactView): string {
  return `<div class="preview fade">
    <div class="row">
      <span class="avatar" style="--av:${avatarColor(handle)}">${esc(handle.slice(0, 2).toUpperCase())}</span>
      <div class="grow" style="min-width:0">
        <div class="strong" style="font-size:15px">@${esc(handle)}</div>
        <div class="muted">Publishes a key to the Ekko directory</div>
      </div>
    </div>
    <div class="divider"></div>
    <h2>Their security code</h2>
    <div class="mono safety">${esc(c.safetyNumber)}</div>
    <p class="hint">This code identifies the key you are about to trust.</p>
    <button id="previewAdd" type="button" class="btn primary block icon" style="margin-top:10px">${I.plus}<span>Add @${esc(handle)}</span></button>
  </div>`;
}

async function addContact(invite: string, name: string): Promise<void> {
  const msg = $('#addMsg');
  msg.className = 'msg err';
  const res = await send({ type: 'addContact', invite, label: name || undefined });
  if (res.error) {
    msg.textContent =
      {
        'thats-you': 'That’s your own invite — share it with someone else.',
        'bad-invite': 'That invite is damaged or incomplete.',
        'not-an-invite': 'That doesn’t look like an Ekko invite (EKK1I:…).',
        locked: 'Ekko is locked.',
      }[res.error] ?? humanError(res.error);
    return;
  }
  await showAddedContact(res.contact);
}

async function showAddedContact(contact: ContactView | null | undefined): Promise<void> {
  contactQuery = '';
  await contactsTab($('#main'), 'Contact added.');
  if (!contact) return;
  document.querySelector<HTMLElement>(`.listrow[data-fp="${contact.fingerprint}"]`)?.scrollIntoView({ block: 'nearest' });
}

// ————— IDENTITY: your key, QR, share —————

// Platforms whose handles can be connected for discovery, with input hints. Kept to the
// live adapters — connecting a handle only pays off where auto-detect can run.
// Name/colour/mark come from BRANDS.
const CONNECT_APPS = [
  { id: 'instagram', hint: 'Instagram username' },
  { id: 'whatsapp', hint: 'Phone, e.g. 15551234567' },
  { id: 'telegram', hint: 'Telegram username' },
  { id: 'messenger', hint: 'Facebook profile URL or numeric ID' },
];

const LINK_ERR: Record<string, string> = {
  'no-handle': 'Claim your @handle above first — connected accounts attach to it.',
  'no-account': 'Your @handle predates discovery — it can’t connect accounts yet.',
  'handle-taken': 'Another Ekko identity already linked that account.',
  'bad-handle': 'That doesn’t look right — check the username.',
  'bad-proof': 'Couldn’t prove your key to the directory — try again.',
  'directory-insecure': 'Couldn’t reach the directory securely — try again later.',
  'directory-unreachable': 'Couldn’t reach the directory — try again.',
  'directory-error': 'The directory had a problem — try again.',
  'verify-unavailable': 'Automatic verification for this app isn’t live yet — the link stays reserved until it is.',
  'verify-expired': 'That code expired — start verification again.',
  locked: 'Ekko is locked.',
};

// Platforms with a live ownership verifier (an Ekko bot that receives the one-time code).
// The server stays authoritative — it answers verify-unavailable for anything else — this
// set only decides where the popup offers the button.
const VERIFIABLE = new Set(['telegram']);

async function identityTab(main: HTMLElement): Promise<void> {
  const inv = await send({ type: 'invite' });
  const invite = inv.invite ?? '';
  const fpHex = inv.fingerprintHex ?? '';
  const username = inv.username ?? '';
  const handles = inv.handles ?? {};
  const acct = await send({ type: 'acctStatus' });
  main.innerHTML = `
    <div class="card center">
      <span class="avatar" style="width:52px;height:52px;font-size:19px;margin:2px auto 8px">You</span>
      <div class="strong" style="font-size:15px">Your Ekko identity</div>
      <p class="muted" style="margin:4px 0 0">Share this invite or QR code with a friend. Your private key never leaves this device.</p>
      <div id="qrbox" class="qrbox"></div>
      <div class="row" style="justify-content:center;flex-wrap:wrap;margin-top:8px">
        <button id="copyInvite" class="btn icon">${I.copy}<span>Copy invite</span></button>
      </div>
      <p class="hint">The full invite is long; QR is the easiest way to exchange it.</p>
    </div>

    <div class="card">
      <h2>Your handle</h2>
      ${
        username
          ? `<p class="muted">Friends can add you as <strong>@${esc(username)}</strong> instead of pasting your invite.</p>
             <div class="row" style="margin-top:6px"><span class="handle-badge grow">@${esc(username)}</span>
                <button id="copyHandle" class="btn ghost" aria-label="Copy @${esc(username)}">${I.copy}</button></div>`
          : `<p class="muted">Claim a short handle so friends can add you by name instead of a long invite. Optional — you can stay invite-only.</p>
              <div class="handle-in" style="margin-top:6px"><span class="at">@</span><input id="claimIn" name="ekko-handle" aria-label="Your Ekko handle" placeholder="yourname" autocomplete="off" spellcheck="false" maxlength="20" /></div>
             <button id="claim" class="btn primary block" style="margin-top:8px">Claim handle</button>`
      }
      <div id="handleMsg" class="msg" role="alert"></div>
    </div>

    <div class="card">
      <h2>Sync with your phone</h2>
      ${
        acct.signedIn
          ? `<p class="muted">Signed in as <strong>${esc(acct.email ?? 'your Ekko account')}</strong>.</p>
             ${
               acct.hasBackup
                 ? `<p class="muted" style="margin-top:6px">An encrypted copy of this identity is on your account. Sign in on your phone and give it the backup passphrase to get the same keys and the same contacts there.</p>
                    <button id="acctBackup" class="btn block" style="margin-top:8px">Back up again</button>
                    <button id="acctDrop" class="btn ghost block" style="margin-top:6px">Remove the copy from Ekko</button>`
                 : `<p class="muted" style="margin-top:6px">Ekko can keep an encrypted copy of your identity and contacts, so your phone is a sign-in instead of typing 24 words. It is locked with a passphrase that never leaves this device: we store the locked copy and cannot open it.</p>
                    <button id="acctBackup" class="btn primary block" style="margin-top:8px">Back up my keys</button>`
             }
             <div id="acctPass" class="hidden" style="margin-top:10px">
               <p class="muted">Save this passphrase. It is the only thing that opens your backup, and Ekko cannot reset it.</p>
               <div id="acctPassText" class="phrase" style="margin-top:6px"></div>
               <button id="acctPassCopy" class="btn block" style="margin-top:6px">Copy passphrase</button>
               <label class="row" style="margin-top:8px;gap:8px;align-items:flex-start">
                 <input type="checkbox" id="acctSaved" style="margin-top:3px" />
                 <span class="muted">I have saved it somewhere safe</span>
               </label>
               <button id="acctGo" class="btn primary block" style="margin-top:8px" disabled>Encrypt and upload</button>
             </div>
             <button id="acctOut" class="btn ghost block" style="margin-top:6px">Sign out</button>`
          : `<p class="muted">Sign in and Ekko can keep an encrypted copy of your identity, so the same keys and contacts show up in the iOS app. We store the locked copy and cannot open it.</p>
             <button id="acctGoogle" class="btn primary block" style="margin-top:8px">Continue with Google</button>
             <p class="hint">Opens a tab. Finish with Google there, then click the Ekko icon again.</p>
             <div class="or"><span>or</span></div>
             <input id="acctEmail" type="email" name="ekko-email" aria-label="Email address" placeholder="you@example.com" autocomplete="off" spellcheck="false" />
             <button id="acctSend" class="btn block" style="margin-top:6px">Email me a sign-in code</button>
             <div id="acctCodeBox" class="hidden" style="margin-top:8px">
               <input id="acctCode" inputmode="numeric" name="ekko-code" aria-label="Sign-in code" placeholder="8 digit code" autocomplete="one-time-code" maxlength="8" />
               <button id="acctVerify" class="btn primary block" style="margin-top:6px">Sign in</button>
             </div>`
      }
      <div id="acctMsg" class="msg" role="alert"></div>
    </div>

    <div class="card tight">
      <div style="padding:10px 0 2px"><h2 style="margin:0">Connected accounts beta</h2>
      <p class="muted" style="margin:4px 0 6px">Reserve the accounts you use with a one-way code. Friends receive suggestions only after Ekko can verify that you control the account.</p></div>
      ${
        username
          ? CONNECT_APPS.map((a) => {
              const b = BRANDS[a.id]!;
              const linked = handles[a.id];
              return `<div class="listrow" data-conn="${a.id}">
                <span class="appicon" style="${brandStyle(b)}">${brandSvg(b)}</span>
                ${
                  linked
                    ? `<div class="grow" style="min-width:0"><div class="strong ellip">${a.id === 'whatsapp' ? esc(linked) : `@${esc(linked)}`}</div><div class="muted">${b.name}</div></div>
                       <span class="chip no" data-conn-chip="${a.id}">checking…</span>
                       <button class="btn ghost" data-conn-verify="${a.id}" hidden>Verify</button>
                       <button class="btn ghost sq danger" data-conn-unlink="${a.id}" title="Unlink" aria-label="Unlink ${b.name}">${I.trash}</button>`
                    : `<div class="grow" style="min-width:0"><input data-conn-in name="${a.id}-handle" aria-label="${b.name} account handle" placeholder="${a.hint}" autocomplete="off" spellcheck="false" maxlength="100" style="margin:0" /></div>
                       <button class="btn ghost" data-conn-go>Link</button>`
                }
              </div>`;
            }).join('')
          : `<p class="hint" style="padding-bottom:10px">Claim your @handle above first — connected accounts attach to it.</p>`
      }
      <div id="connMsg" class="msg err" role="alert"></div>
    </div>`;

  // QR loads lazily
  const { default: QRCode } = await import('qrcode');
  const png = await QRCode.toDataURL([{ data: new TextEncoder().encode(invite), mode: 'byte' }], IDENTITY_QR_OPTIONS);
  $('#qrbox').innerHTML = `<img class="qr" src="${png}" width="290" height="290" alt="Your Ekko invite QR code" />`;

  $('#copyInvite').addEventListener('click', () => copyFeedback($('#copyInvite'), invite));

  // --- Ekko account: the encrypted backup that makes this browser and the phone interchangeable.
  // The passphrase is GENERATED and shown once. That is the security model, not a flourish: the
  // key derivation is fast, so a passphrase a person invents is the weak link; six random words
  // are not. See src/core/backup.ts.
  const acctMsg = (text: string, err = true) => {
    const el = $('#acctMsg');
    el.textContent = text;
    el.className = `msg ${err ? 'err' : 'ok'}`;
  };

  // Google, by way of a tab. There is no launchWebAuthFlow to reach for here — Safari has no
  // browser.identity at all — so the background opens the flow, it lands on the account page, and
  // that page's session is handed back by a content script. Opening a tab closes this popup, which
  // is why the copy tells you to come back to it rather than pretending to wait.
  $('#acctGoogle')?.addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('#acctGoogle');
    setBusy(btn, true);
    const res = await send({ type: 'acctGoogle' });
    if (res.error) {
      setBusy(btn, false);
      return acctMsg(humanError(res.error));
    }
    window.close();
  });

  $('#acctSend')?.addEventListener('click', async () => {
    const email = $<HTMLInputElement>('#acctEmail').value.trim();
    if (!email.includes('@')) return acctMsg('Enter your email address.');
    const btn = $<HTMLButtonElement>('#acctSend');
    setBusy(btn, true);
    const res = await send({ type: 'acctSendCode', email });
    setBusy(btn, false);
    if (res.error) return acctMsg(humanError(res.error));
    $('#acctCodeBox').classList.remove('hidden');
    acctMsg('Check your mail for an 8 digit code.', false);
  });

  $('#acctVerify')?.addEventListener('click', async () => {
    const email = $<HTMLInputElement>('#acctEmail').value.trim();
    const code = $<HTMLInputElement>('#acctCode').value.trim();
    const btn = $<HTMLButtonElement>('#acctVerify');
    setBusy(btn, true);
    const res = await send({ type: 'acctVerify', email, code });
    setBusy(btn, false);
    if (res.error) return acctMsg(humanError(res.error));
    await identityTab(main); // re-render into the signed-in state
  });

  $('#acctOut')?.addEventListener('click', async () => {
    await send({ type: 'acctSignOut' });
    await identityTab(main);
  });

  let generated = '';
  $('#acctBackup')?.addEventListener('click', () => {
    generated = generatePassphrase();
    $('#acctPassText').textContent = generated;
    $('#acctPass').classList.remove('hidden');
    $<HTMLInputElement>('#acctSaved').checked = false;
    $<HTMLButtonElement>('#acctGo').disabled = true;
    acctMsg('', false);
  });

  $('#acctPassCopy')?.addEventListener('click', () =>
    copyFeedback($('#acctPassCopy'), generated),
  );

  $('#acctSaved')?.addEventListener('change', (e) => {
    $<HTMLButtonElement>('#acctGo').disabled = !(e.target as HTMLInputElement).checked;
  });

  $('#acctGo')?.addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('#acctGo');
    setBusy(btn, true);
    const res = await send({ type: 'acctBackup', backupPassphrase: generated });
    setBusy(btn, false);
    if (res.error) {
      return acctMsg(
        res.error === 'locked'
          ? 'Unlock Ekko first.'
          : res.error === 'no-phrase'
            ? 'This older identity has no recovery phrase, so it cannot be backed up.'
            : humanError(res.error),
      );
    }
    acctMsg('Encrypted and stored. Sign in on your phone to bring it down.', false);
    $('#acctPass').classList.add('hidden');
  });

  const drop = $('#acctDrop');
  if (drop)
    armed(drop, 'Delete the backup?', async () => {
      const res = await send({ type: 'acctDeleteBackup' });
      if (res.error) return acctMsg(humanError(res.error));
      await identityTab(main);
    });

  // The badge is the DIRECTORY's answer, fetched after paint — never a local guess.
  if (Object.keys(handles).length) {
    void send({ type: 'handleStatus' }).then((res) => {
      for (const chip of $$('[data-conn-chip]')) {
        const platform = chip.dataset.connChip!;
        const state = res.verifiedHandles?.[platform];
        chip.textContent = state === true ? 'verified' : state === false ? 'verification pending' : 'couldn’t check';
        chip.className = `chip ${state === true ? 'ok' : 'no'}`;
        // Offer the ceremony only where a verifier exists and the mapping still needs it.
        if (state === false && VERIFIABLE.has(platform)) $(`[data-conn-verify="${platform}"]`)?.removeAttribute('hidden');
      }
    });
  }

  const connMsg = (code: string) => {
    $('#connMsg').textContent = LINK_ERR[code] ?? humanError(code);
  };

  for (const btn of $$('[data-conn-unlink]')) {
    const platform = btn.dataset.connUnlink!;
    armed(btn, `Unlink ${BRANDS[platform]?.name ?? platform}?`, async () => {
      const res = await send({ type: 'unlinkPlatform', platform });
      if (res.error) return connMsg(res.error);
      await identityTab(main);
    });
  }

  // The ownership ceremony: get a one-time code, send it to the Ekko bot FROM the account
  // being claimed, and poll until the platform has asserted the sender. Server state is the
  // only truth — the chip flips when handleStatus says so, never optimistically.
  for (const btn of $$('[data-conn-verify]')) {
    btn.addEventListener('click', async () => {
      const platform = btn.dataset.connVerify!;
      const row = btn.closest('.listrow')!;
      if (row.nextElementSibling?.classList.contains('verify-panel')) return;
      setBusy(btn as HTMLButtonElement, true);
      const res = await send({ type: 'verifyStart', platform });
      setBusy(btn as HTMLButtonElement, false);
      if (res.error || !res.verify) return connMsg(res.error ?? 'directory-error');
      const { code, checkId, bot } = res.verify;
      const panel = document.createElement('div');
      panel.className = 'verify-panel';
      panel.innerHTML = `
        <p class="muted">Send this code to <strong>@${esc(bot.username)}</strong> on Telegram — from the account you are linking. Ekko confirms by whom it arrives, so nobody can verify a handle they don’t control.</p>
        <div class="phrase" style="margin-top:6px">${esc(code)}</div>
        <div class="row" style="margin-top:6px">
          <button class="btn grow" data-verify-copy>Copy code</button>
          <a class="btn primary" href="https://t.me/${encodeURIComponent(bot.username)}?start=${encodeURIComponent(code)}" target="_blank" rel="noreferrer">Open Telegram</a>
        </div>
        <div class="msg" data-verify-status role="status" aria-live="polite">Waiting for your message to the bot…</div>`;
      row.after(panel);
      $('[data-verify-copy]', panel)?.addEventListener('click', () => copyFeedback($('[data-verify-copy]', panel), code));
      const status = $('[data-verify-status]', panel);
      const poll = setInterval(async () => {
        if (!panel.isConnected) return clearInterval(poll); // tab re-rendered under us
        const r = await send({ type: 'verifyCheck', checkId });
        if (r.verifyStatus === 'verified') {
          clearInterval(poll);
          await identityTab(main); // chip re-reads handleStatus: server state, not our hope
          return;
        }
        if (r.error && r.error !== 'directory-unreachable') {
          clearInterval(poll);
          status.className = 'msg err';
          status.textContent = LINK_ERR[r.error] ?? humanError(r.error);
        }
      }, 3000);
    });
  }

  for (const row of $$('[data-conn]')) {
    const go = async () => {
      const input = $<HTMLInputElement>('[data-conn-in]', row);
      const val = input?.value.trim();
      if (!val) return;
      const btn = $<HTMLButtonElement>('[data-conn-go]', row);
      setBusy(btn, true);
      const res = await send({ type: 'linkPlatform', platform: row.dataset.conn!, handle: val });
      if (res.error) {
        setBusy(btn, false);
        $('#connMsg').textContent = LINK_ERR[res.error] ?? humanError(res.error);
        return;
      }
      await identityTab(main);
    };
    $('[data-conn-go]', row)?.addEventListener('click', go);
    $<HTMLInputElement>('[data-conn-in]', row)?.addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && void go());
  }
  if (username) $('#copyHandle')?.addEventListener('click', () => copyFeedback($('#copyHandle'), `@${username}`));
  else {
    const claim = async () => {
      const h = $<HTMLInputElement>('#claimIn').value.trim().replace(/^@/, '').toLowerCase();
      const msg = $('#handleMsg');
      msg.className = 'msg err';
      if (!HANDLE_RE.test(h)) return void (msg.textContent = 'Handle: 3–20 letters, numbers or _.');
      const btn = $<HTMLButtonElement>('#claim');
      setBusy(btn, true);
      const res = await send({ type: 'dirClaim', username: h });
      if (res.error) {
        setBusy(btn, false);
        return void (msg.textContent = handleClaimError(res.error));
      }
      await identityTab(main);
    };
    $('#claim')?.addEventListener('click', claim);
    $<HTMLInputElement>('#claimIn')?.addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && void claim());
  }
}

// ————— SETTINGS: lock / password / backup / advanced —————

async function settingsTab(main: HTMLElement): Promise<void> {
  const settings = await send({ type: 'getSettings' });
  const tagOn = settings.tagline ?? false;
  const discoverOn = settings.discover ?? false;
  // Popup-owned storage flag, read live by every content script — no background hop.
  const debugOn = !!(await chrome.storage.local.get('rsn.debug'))['rsn.debug'];
  main.innerHTML = `
    <div class="card tight">
      <button id="lock" class="btn ghost icon" style="width:100%;justify-content:flex-start;padding:12px 2px">${I.lock}<span>Lock Ekko</span></button>
    </div>

    <div class="card">
      <div class="row"><div class="grow"><div class="strong">Add an Ekko tag to messages</div>
        <div class="muted">A short line on encrypted messages so friends who don’t have Ekko yet know what it is.</div></div>
        <label class="switch"><input type="checkbox" id="tagToggle" aria-label="Add an Ekko tag to messages" ${tagOn ? 'checked' : ''} /><span class="track"></span></label></div>
    </div>

    <div class="card">
      <div class="row"><div class="grow"><div class="strong">Suggest encryption automatically</div>
        <div class="muted">When enabled, Ekko checks a one-way code for the open account. Only verified account links can become suggestions. Anonymous mode never contacts the directory.</div></div>
        <label class="switch"><input type="checkbox" id="discoverToggle" aria-label="Suggest encryption automatically" ${discoverOn ? 'checked' : ''} /><span class="track"></span></label></div>
      <div id="discoverMsg" class="msg err" role="status"></div>
    </div>

    <div class="card">
      <div class="row"><div class="grow"><div class="strong">Stay unlocked on this device</div>
        <div class="muted">Ekko is ready the moment your browser starts — no password screen, no paused chats. Your computer's login becomes the lock, so leave this off on a shared computer.</div></div>
        <label class="switch"><input type="checkbox" id="keepToggle" aria-label="Stay unlocked on this device" ${settings.keepUnlocked ? 'checked' : ''} /><span class="track"></span></label></div>
    </div>

    <div class="card">
      <div class="row"><div class="grow"><div class="strong">Show debug overlay in chats</div>
        <div class="muted">A small readout on chat pages showing what Ekko detects. For testing; send a screenshot of it when something looks wrong.</div></div>
        <label class="switch"><input type="checkbox" id="debugToggle" aria-label="Show debug overlay in chats" ${debugOn ? 'checked' : ''} /><span class="track"></span></label></div>
    </div>

    <details class="card adv">
      <summary><strong style="font-size:13px">Change password</strong></summary>
      <div style="margin-top:10px">
        ${pwField('op', 'Current password')}
        ${pwField('np', 'New password (min. 8)', 'new-password')}
        <button id="chg" class="btn primary block" style="margin-top:6px">Update password</button>
        <div id="chgMsg" class="msg" role="alert"></div>
      </div>
    </details>

    <details class="card adv">
      <summary><strong style="font-size:13px">Backup</strong></summary>
      <div style="margin-top:10px">
        <p class="muted">Save an encrypted copy of your keys. You’ll need your password to restore it.</p>
        <button id="exp" class="btn block">Download encrypted backup</button>
        <div class="divider"></div>
        <p class="muted">Your 24-word recovery phrase restores the same identity on another device. Keep it offline and private.</p>
        <button id="showPhrase" class="btn block">Show recovery phrase</button>
        <div id="phraseBox" class="hidden">
          <div id="phraseText" class="phrase" translate="no" style="margin-top:10px"></div>
          <button id="copyPhrase" class="btn ghost icon" style="margin-top:6px">${I.copy}<span>Copy recovery phrase</span></button>
        </div>
        <div id="phraseMsg" class="msg err" role="status"></div>
        <div class="divider"></div>
        ${backupImportHtml()}
      </div>
    </details>

    <details class="card adv">
      <summary><strong style="font-size:13px">Advanced — manual encrypt / decrypt</strong></summary>
      <div style="margin-top:10px">
        <p class="hint">Choose where you will paste the blocks. This copy/paste tool never controls that app.</p>
        <label class="field" for="manualPlatform">Paste into</label>
         <select id="manualPlatform" aria-label="Destination app">${MANUAL_PLATFORMS.map((p) => `<option value="${p.id}">${p.label}</option>`).join('')}</select>
         <select id="encTo" aria-label="Contact to encrypt for"></select>
         <textarea id="encIn" aria-label="Message to encrypt" placeholder="Message to encrypt…"></textarea>
        <button id="encGo" class="btn">Encrypt</button>
         <textarea id="encOut" aria-label="Encrypted message blocks" placeholder="Sendable blocks appear here…" readonly></textarea>
        <div class="divider"></div>
         <textarea id="decIn" aria-label="Encrypted tokens to decrypt" placeholder="Paste Ekko tokens to decrypt…" spellcheck="false"></textarea>
        <button id="decGo" class="btn">Decrypt</button>
        <div id="decOut" class="msg"></div>
      </div>
    </details>

    <details class="card adv">
      <summary><strong style="font-size:13px">Advanced — directory server</strong></summary>
      <div style="margin-top:10px">
        <p class="muted">Ekko looks handles up on this directory. Point it at your own
        (<a href="https://github.com/vasilevklart/ekko-client/tree/main/server" target="_blank" rel="noreferrer">self-host guide</a>) — https only. Handles claimed on one directory don’t exist on another.</p>
        <input id="dirUrl" type="url" name="directory-url" aria-label="Directory server URL" placeholder="https://useekko.app" autocomplete="off" spellcheck="false" value="${esc(settings.directory ?? '')}" />
        <div class="row" style="margin-top:6px">
          <button id="dirSave" class="btn grow">Use this directory</button>
          <button id="dirReset" class="btn ghost">Reset</button>
        </div>
        <div id="dirMsg" class="msg" role="alert"></div>
      </div>
    </details>

    <p class="hint center">Ekko v${chrome.runtime.getManifest?.().version ?? ''} · keys stored only on this device</p>`;

  wireEyes(main);
  $('#lock').addEventListener('click', async () => {
    await send({ type: 'lock' });
    await render();
  });
  $<HTMLInputElement>('#tagToggle').addEventListener('change', (e) =>
    void send({ type: 'setTagline', enabled: (e.target as HTMLInputElement).checked }),
  );
  $<HTMLInputElement>('#discoverToggle').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const enabled = input.checked;
    input.disabled = true;
    const res = await send({ type: 'setDiscover', enabled });
    input.disabled = false;
    if (!res.error) return;
    input.checked = !enabled;
    $('#discoverMsg').textContent =
      res.error === 'no-handle'
        ? 'Claim an Ekko handle before enabling directory suggestions.'
        : 'Ekko couldn’t save this privacy setting. Nothing changed.';
  });
  $<HTMLInputElement>('#debugToggle').addEventListener('change', (e) =>
    void chrome.storage.local.set({ 'rsn.debug': (e.target as HTMLInputElement).checked }),
  );
  $<HTMLInputElement>('#keepToggle').addEventListener('change', (e) =>
    void send({ type: 'setKeepUnlocked', enabled: (e.target as HTMLInputElement).checked }),
  );
  $('#chg').addEventListener('click', changePassword);
  $('#exp').addEventListener('click', exportBackup);
  $('#showPhrase').addEventListener('click', async () => {
    const box = $('#phraseBox');
    const btn = $<HTMLButtonElement>('#showPhrase');
    if (!box.classList.contains('hidden')) {
      box.classList.add('hidden');
      $('#phraseText').textContent = '';
      btn.textContent = 'Show recovery phrase';
      return;
    }
    // Two-tap reveal: these words ARE the identity, so the first tap only warns (in the
    // button itself — no OS dialog) and the second, within 4s, shows them.
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.classList.add('armed');
      btn.textContent = 'Anyone who sees them can be you — show now?';
      setTimeout(() => {
        if (!btn.isConnected || !btn.dataset.armed) return;
        delete btn.dataset.armed;
        btn.classList.remove('armed');
        btn.textContent = 'Show recovery phrase';
      }, 4000);
      return;
    }
    delete btn.dataset.armed;
    btn.classList.remove('armed');
    setBusy(btn, true);
    const res = await send({ type: 'getRecoveryPhrase' });
    setBusy(btn, false);
    if (!res.mnemonic) {
      $('#phraseMsg').textContent =
        res.error === 'no-phrase'
          ? 'This older identity has no recovery phrase. Download an encrypted backup instead.'
          : 'Ekko couldn’t load your recovery phrase.';
      btn.textContent = 'Show recovery phrase';
      return;
    }
    $('#phraseText').textContent = res.mnemonic;
    box.classList.remove('hidden');
    btn.textContent = 'Hide recovery phrase';
  });
  $('#copyPhrase').addEventListener('click', () => copyFeedback($('#copyPhrase'), $('#phraseText').textContent ?? ''));
  wireBackupImport();

  // populate advanced tools
  const contacts = (await send({ type: 'contacts' })).contacts ?? [];
  $('#encTo').innerHTML = contacts.map((c) => `<option value="${c.fingerprint}">${esc(c.label)}</option>`).join('') || '<option disabled>No contacts</option>';
  $('#encGo').addEventListener('click', manualEncrypt);
  $('#decGo').addEventListener('click', manualDecrypt);

  const dirApply = async (url: string) => {
    const msg = $('#dirMsg');
    const res = await send({ type: 'setDirectory', url });
    if (res.error) {
      msg.className = 'msg err';
      msg.textContent = 'That has to be an https:// URL.';
      return;
    }
    $<HTMLInputElement>('#dirUrl').value = res.directory ?? '';
    msg.className = 'msg ok';
    msg.textContent = `Using ${res.directory}.`;
  };
  $('#dirSave').addEventListener('click', () => void dirApply($<HTMLInputElement>('#dirUrl').value.trim()));
  $('#dirReset').addEventListener('click', () => void dirApply(''));
}

async function changePassword(): Promise<void> {
  const oldP = $<HTMLInputElement>('#op').value;
  const newP = $<HTMLInputElement>('#np').value;
  const msg = $('#chgMsg');
  if (newP.length < 8) return void ((msg.className = 'msg err'), (msg.textContent = 'New password must be at least 8 characters.'));
  const res = await send({ type: 'changePassphrase', oldPassphrase: oldP, newPassphrase: newP });
  if (res.error) {
    msg.className = 'msg err';
    msg.textContent = res.error === 'wrong-passphrase' ? 'Current password is wrong.' : humanError(res.error);
    return;
  }
  msg.className = 'msg ok';
  msg.textContent = 'Password updated.';
  $<HTMLInputElement>('#op').value = '';
  $<HTMLInputElement>('#np').value = '';
}

async function manualEncrypt(): Promise<void> {
  const fp = $<HTMLSelectElement>('#encTo').value;
  const text = $<HTMLTextAreaElement>('#encIn').value;
  const platform = selectedManualPlatform();
  if (!fp || !text.trim() || !platform) return;
  const threadId = manualThreadId(platform);
  const res = await send({ type: 'manualEncrypt', threadId, fingerprint: fp, plaintext: text });
  const out = $<HTMLTextAreaElement>('#encOut');
  if (!res.tokens) {
    out.value = humanError(res.error);
    return;
  }
  try {
    out.value = res.tokens.flatMap((t) => splitMessage(t, IG_MAX_MESSAGE_LEN, randomChunkId())).join('\n\n');
  } catch {
    // splitMessage refuses tokens over its chunk cap (~170 KB of text).
    out.value = 'Too long to encrypt as one message — split the text and encrypt the parts separately.';
  }
}

function selectedManualPlatform(): ManualPlatformId | null {
  const id = $<HTMLSelectElement>('#manualPlatform').value;
  return MANUAL_PLATFORMS.find((p) => p.id === id)?.id ?? null;
}

const DECRYPT_ERR: Record<string, string> = {
  'no-session': 'No matching session — paste their handshake block first.',
  'wrong-peer': 'That message is from a different contact than the first one you pasted.',
  'decrypt-failed': 'Couldn’t decrypt — the message looks corrupted or isn’t addressed to you.',
  'bad-token': 'That isn’t a valid Ekko message.',
  'bad-handshake': 'That handshake is invalid.',
};

async function manualDecrypt(): Promise<void> {
  const tokens = ($<HTMLTextAreaElement>('#decIn').value.match(new RegExp(TOKEN_RE.source, 'g')) ?? []);
  const out = $('#decOut');
  if (!tokens.length) return void ((out.className = 'msg err'), (out.textContent = 'No Ekko tokens found.'));
  const platform = selectedManualPlatform();
  if (!platform) return void ((out.className = 'msg err'), (out.textContent = 'Choose a destination app first.'));
  const reasm = new Reassembler();
  const whole: string[] = [];
  for (const t of tokens) {
    const c = classify(t);
    if (!c) continue;
    if (c.kind === 'chunk') {
      const w = reasm.add(c.raw);
      if (w) whole.push(w);
    } else whole.push(c.raw);
  }
  // Manual decrypt is intentionally unbound, but its session context must persist across
  // multiple paste operations in this popup.
  const threadId = manualThreadId(platform);
  const lines: string[] = [];
  let anyErr = false;
  for (const raw of whole) {
    const c = classify(raw)!;
    const res = await send({ type: 'ingest', threadId, kind: c.kind, raw: c.raw, manual: true });
    if (res.plaintext !== undefined) lines.push(res.plaintext);
    else if (res.added) lines.push(`Added contact: ${res.added.label}`);
    else if (res.ok) lines.push('Secure channel established.');
    else {
      anyErr = true;
      lines.push(DECRYPT_ERR[res.error ?? ''] ?? humanError(res.error));
    }
  }
  out.className = anyErr ? 'msg err' : 'msg ok';
  out.textContent = lines.join('\n') || 'Only partial chunks — paste every block.';
}

// ————— backup import (shared) —————

function backupImportHtml(): string {
  return `<div class="rsn-import">
    <button class="btn imp-pick">Restore from backup file…</button>
    <input class="imp-file" type="file" accept="application/json" hidden />
    <div class="imp-step hidden" style="margin-top:8px">
      ${pwField('imp-pass', 'Backup password')}
      <button class="btn primary imp-go" style="margin-top:6px">Decrypt &amp; restore</button>
    </div>
    <div class="imp-msg msg err" role="alert"></div>
  </div>`;
}

function wireBackupImport(): void {
  for (const root of $$('.rsn-import')) {
    let fileText = '';
    $('.imp-pick', root).addEventListener('click', () => $<HTMLInputElement>('.imp-file', root).click());
    $<HTMLInputElement>('.imp-file', root).addEventListener('change', async (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      fileText = await f.text();
      $('.imp-step', root).classList.remove('hidden');
      wireEyes(root);
    });
    $('.imp-go', root).addEventListener('click', async () => {
      const res = await send({ type: 'import', blob: fileText, passphrase: $<HTMLInputElement>('.imp-pass', root).value });
      if (res.error) {
        $('.imp-msg', root).textContent =
          res.error === 'wrong-passphrase' ? 'Wrong password for this backup.' : res.error === 'bad-backup' ? 'That file isn’t an Ekko backup.' : humanError(res.error);
        return;
      }
      await broadcastRescan();
      await render();
    });
  }
}

async function exportBackup(): Promise<void> {
  const res = await send({ type: 'export' });
  if (!res.invite) return;
  const url = URL.createObjectURL(new Blob([res.invite], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ekko-backup.json';
  a.click();
  URL.revokeObjectURL(url);
}

// Sync on every popup open, whichever tab renders: fresh keys, linked handles, staged
// sessions — and the tab rescan they imply — must not depend on the user ever visiting
// the Contacts tab. Concurrent with contactsTab's own sync by design; the background
// serializes them into one run.
void send({ type: 'acctSync' }).then((res) => {
  if (res.ok) void broadcastRescan();
});

void render();
