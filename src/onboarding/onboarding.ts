// Ekko onboarding — full-tab first-run flow (opened on install). All crypto lives in
// the background service worker; this is view logic only, mirroring popup.ts patterns.
import { send } from '../core/rpc.js';
import { humanError } from '../core/errors.js';
import { inviteMessage } from '../core/growth.js';

const app = document.getElementById('app')!;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll(sel)) as T[];

// Mirrors HANDLE_RE in popup.ts / USERNAME_RE in background.ts.
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
let protectPhrase = false;
// The Google flow finishes in a DIFFERENT tab, and nothing tells this one. Whichever view is
// waiting on a sign-in registers itself here; the one page-wide listener below asks again when
// this tab is looked at. A view that stops caring sets it back to null by rendering.
let accountWatch: (() => void) | null = null;
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) accountWatch?.();
});

const I = {
  // Balanced Packet E — keep in sync with popup.ts and the site.
  logo: '<svg viewBox="0 0 48 48" fill="currentColor"><rect x="5" y="4" width="9" height="40" rx="4.5"/><rect x="17" y="4" width="27" height="9" rx="4.5"/><rect x="17" y="19.5" width="19" height="9" rx="4.5"/><rect x="17" y="35" width="27" height="9" rx="4.5"/><circle cx="42" cy="24" r="3"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m4.5 12.5 5 5 10-11"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l16 16"/><path d="M9.9 5.2A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a15 15 0 0 1-3 3.6M6 6.6A15 15 0 0 0 2 12s3.5 7 10 7a9.5 9.5 0 0 0 3.4-.6"/></svg>',
};

// password field with a show/hide eye (same pattern as popup.ts)
function pwField(id: string, placeholder: string, autocomplete = 'current-password'): string {
  return `<div class="pw">
    <input id="${id}" name="${id}" type="password" aria-label="${placeholder}" placeholder="${placeholder}" autocomplete="${autocomplete}" spellcheck="false" />
    <button class="eye" data-eye="${id}" type="button" aria-label="Show password">${I.eye}</button>
  </div>`;
}

function setBusy(btn: HTMLButtonElement, on: boolean): void {
  btn.disabled = on;
  btn.toggleAttribute('aria-busy', on);
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

function onEnter(sel: string, fn: () => void): void {
  $<HTMLInputElement>(sel).addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && fn());
}

// The sign-in card, shared by the account-restore flow and the "@you, everywhere" road. Google by
// way of a tab (Safari has no browser.identity, so there is no launchWebAuthFlow to reach for; it
// also costs no OTP email, which matters when the mail quota is the bottleneck) or the emailed
// 8-digit code. `onSignedIn` is the continuation — the two flows differ only in where they go next.
function signInCardHTML(): string {
  return `<div class="card">
    <button id="google" class="btn primary block">Continue with Google</button>
    <p class="hint">Opens a tab. Finish with Google there, then come back to this one.</p>
    <div class="or"><span>or</span></div>
    <label class="field" for="email">Email</label>
    <input id="email" type="email" name="ekko-email" placeholder="you@example.com" autocomplete="off" spellcheck="false" />
    <button id="send" class="btn block" style="margin-top:8px">Email me an 8 digit code</button>
    <div id="codeBox" class="hidden" style="margin-top:8px">
      <label class="field" for="code">Code</label>
      <input id="code" inputmode="numeric" name="ekko-code" placeholder="8 digit code" autocomplete="one-time-code" maxlength="8" />
      <button id="verify" class="btn primary block" style="margin-top:8px">Sign in</button>
    </div>
    <div id="msg" class="msg err" role="alert"></div>
  </div>`;
}

function wireSignInCard(onSignedIn: () => void): void {
  $('#google').addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('#google');
    setBusy(btn, true);
    const res = await send({ type: 'acctGoogle' });
    // Un-busy either way: the flow now lives in the other tab, and if they back out of Google
    // they return to this one — a button stuck spinning would be a lie.
    setBusy(btn, false);
    if (res.error) return void ($('#msg').textContent = humanError(res.error));
  });

  $('#send').addEventListener('click', async () => {
    const email = $<HTMLInputElement>('#email').value.trim();
    if (!email.includes('@')) return void ($('#msg').textContent = 'Enter your email address.');
    const btn = $<HTMLButtonElement>('#send');
    setBusy(btn, true);
    const res = await send({ type: 'acctSendCode', email });
    setBusy(btn, false);
    if (res.error) return void ($('#msg').textContent = humanError(res.error));
    $('#codeBox').classList.remove('hidden');
    $('#msg').textContent = '';
  });

  const verify = async () => {
    const email = $<HTMLInputElement>('#email').value.trim();
    const code = $<HTMLInputElement>('#code').value.trim();
    const btn = $<HTMLButtonElement>('#verify');
    setBusy(btn, true);
    const res = await send({ type: 'acctVerify', email, code });
    setBusy(btn, false);
    if (res.error) return void ($('#msg').textContent = humanError(res.error));
    onSignedIn();
  };
  $('#verify').addEventListener('click', () => void verify());
  onEnter('#code', () => void verify());

  // Google finishing in the other tab makes THIS tab signed in without an event. Ask on return.
  accountWatch = () =>
    void send({ type: 'acctStatus' }).then((s) => {
      if (s.signedIn) onSignedIn();
    });
}

// ————— screens —————

function welcome(): void {
  app.innerHTML = `
    <main class="fade">
      <div class="hero">
        <span class="logo">${I.logo}</span>
        <h1>Welcome to Ekko</h1>
        <p>Private, post-quantum encrypted messaging on top of the apps you already use. Your keys stay on this device.</p>
      </div>
      <button id="create" class="btn primary block">Create a new identity</button>
      <div class="or"><span>or</span></div>
      <button id="import" class="btn block">I already have a recovery phrase</button>
      <button id="restore" class="btn block" style="margin-top:8px">Restore from my Ekko account</button>
      <p class="hint center">Takes about a minute · an account is optional</p>
    </main>`;
  $('#create').addEventListener('click', passView);
  $('#import').addEventListener('click', importView);
  $('#restore').addEventListener('click', accountRestoreView);
}

// Bring an identity down from the Ekko account — the same encrypted blob the iOS app writes and
// reads, so a phone and a browser end up holding the same keys and the same contacts. The server
// handed us ciphertext and could not have done otherwise: the passphrase never left the device that
// made the backup, and it does not leave this one.
function accountRestoreView(): void {
  const render = (signedIn: boolean, email?: string, hasBackup?: boolean) => {
    app.innerHTML = `
    <main class="fade" id="restoreRoot">
      <p class="kicker">Restore</p>
      <h1>Bring your identity back</h1>
      ${
        !signedIn
          ? `<p class="lead">Sign in to the account that holds your encrypted backup.</p>
             ${signInCardHTML()}`
          : hasBackup
            ? `<p class="lead">Found an encrypted backup on <strong>${esc(email ?? 'your account')}</strong>. Give it the passphrase you saved and it opens here.</p>
               <div class="card">
                 <label class="field" for="bp">Backup passphrase</label>
                 ${pwField('bp', 'The six words you saved')}
                 <label class="field" for="p1" style="margin-top:10px">Password for this browser</label>
                 ${pwField('p1', 'Password (min. 8 characters)', 'new-password')}
                 <div id="msg" class="msg err" role="alert"></div>
               </div>
               <button id="go" class="btn primary block">Restore</button>
               <button id="fresh" class="btn ghost block" style="margin-top:6px">I don’t have my passphrase — start fresh on this account</button>`
            : `<p class="lead">Signed in as <strong>${esc(email ?? '')}</strong>, but this account has no backup to open here. If your identity lives on another device, its 24 words bring it back exactly. Otherwise Ekko can make new keys on this account and restore the people you are connected to.</p>
               <button id="toImport" class="btn primary block">Enter my recovery phrase</button>
               <button id="fresh" class="btn block" style="margin-top:6px">Start fresh on this account</button>`
      }
      <button id="back" class="btn ghost block">Back</button>
    </main>`;

    accountWatch = null; // signed-in branches have nothing to wait for; wireSignInCard re-arms
    $('#back').addEventListener('click', welcome);
    $('#toImport')?.addEventListener('click', importView);
    $('#fresh')?.addEventListener('click', () => startFreshView(email));
    wireEyes(); // the has-backup branch renders bp + p1 password eyes; without this they're dead
    if (!signedIn) wireSignInCard(() => void accountRestoreView());

    $('#go')?.addEventListener('click', async () => {
      const backupPassphrase = $<HTMLInputElement>('#bp').value;
      const passphrase = $<HTMLInputElement>('#p1').value;
      if (passphrase.length < 8) {
        return void ($('#msg').textContent = 'Your browser password needs at least 8 characters.');
      }
      const btn = $<HTMLButtonElement>('#go');
      setBusy(btn, true);
      const res = await send({ type: 'acctRestore', backupPassphrase, passphrase });
      setBusy(btn, false);
      if (res.error || !res.ok) {
        return void ($('#msg').textContent =
          res.error === 'vault-exists'
            ? 'This browser already holds an identity.'
            : res.error === 'no-backup'
              ? 'There is no backup on this account.'
              : res.error
                ? humanError(res.error)
                : 'That passphrase does not open the backup.');
      }
      // Same keys, same people — that is the whole promise. Straight to the last step.
      handleView('Last step');
    });
  };

  render(false);
  void send({ type: 'acctStatus' }).then((s) => {
    if (s.signedIn) render(true, s.email, s.hasBackup);
  });
}

// Reset onto the account you are signed in to: when you have no backup and no 24 words, make a NEW
// identity, publish it to this account (adopt=true keeps the session), and pull back the people you
// are connected to. Old messages stay sealed to the old key; the account, handle and connections
// come with you. This is the escape hatch that used to be missing — you were stuck at "signed in,
// but no way in".
function startFreshView(email?: string): void {
  app.innerHTML = `
    <main class="fade">
      <p class="kicker">Reset</p>
      <h1>Start fresh on this account</h1>
      <p class="lead">Signed in as <strong>${esc(email ?? 'your account')}</strong>, but there is no backup to open and no recovery phrase. Ekko can make new keys on this account and bring back the people you are connected to. Your old messages stay sealed to the old key — your account, your handle and your connections come with you.</p>
      <div class="card">
        <label class="field" for="p1">Password for this browser</label>
        ${pwField('p1', 'Password (min. 8 characters)', 'new-password')}
        <label class="field" for="p2" style="margin-top:10px">Repeat password</label>
        ${pwField('p2', 'Repeat password', 'new-password')}
        <div id="msg" class="msg err" role="alert"></div>
      </div>
      <button id="go" class="btn primary block">Create new keys and restore my people</button>
      <button id="back" class="btn ghost block">Back</button>
    </main>`;
  wireEyes();
  $('#back').addEventListener('click', accountRestoreView);
  $('#go').addEventListener('click', async () => {
    const p1 = $<HTMLInputElement>('#p1').value;
    const p2 = $<HTMLInputElement>('#p2').value;
    if (p1.length < 8) return void ($('#msg').textContent = 'Your browser password needs at least 8 characters.');
    if (p1 !== p2) return void ($('#msg').textContent = 'Those passwords do not match.');
    const btn = $<HTMLButtonElement>('#go');
    setBusy(btn, true);
    // adopt=true: keep the signed-in account and republish this new key onto it.
    const res = await send({ type: 'create', passphrase: p1, adopt: true });
    if (res.error) {
      setBusy(btn, false);
      return void ($('#msg').textContent =
        res.error === 'vault-exists' ? 'This browser already holds an identity.' : humanError(res.error));
    }
    // Publish the new key to the account and pull the people you are connected to as contacts.
    await send({ type: 'acctSync' });
    setBusy(btn, false);
    handleView('Last step');
  });
}

function passView(): void {
  app.innerHTML = `
    <main class="fade">
      <p class="kicker">Step 1 of 3</p>
      <h1>Set a password</h1>
      <p class="lead">It protects your keys on this device. You’ll enter it to unlock Ekko.</p>
      <div class="card">
        <label class="field" for="p1">Password</label>
        ${pwField('p1', 'Password (min. 8 characters)', 'new-password')}
        ${pwField('p2', 'Repeat password', 'new-password')}
        <label class="ck" style="margin-top:10px"><input id="keep" type="checkbox" checked />
          Keep me unlocked on this device. Ekko is ready when your browser starts; your computer's login is the lock. Untick on a shared computer.</label>
        <div id="msg" class="msg err" role="alert"></div>
      </div>
      <button id="go" class="btn primary block">Create identity</button>
      <button id="back" class="btn ghost block">Back</button>
    </main>`;
  wireEyes();
  $('#back').addEventListener('click', welcome);
  const go = async () => {
    const p1 = $<HTMLInputElement>('#p1').value;
    const p2 = $<HTMLInputElement>('#p2').value;
    const msg = $('#msg');
    if (p1.length < 8) return void (msg.textContent = 'Use at least 8 characters.');
    if (p1 !== p2) return void (msg.textContent = 'Passwords don’t match.');
    msg.textContent = '';
    const btn = $<HTMLButtonElement>('#go');
    setBusy(btn, true);
    const res = await send({ type: 'create', passphrase: p1 });
    if (res.error || !res.mnemonic) {
      if (res.error === 'vault-exists') return alreadySetUp();
      setBusy(btn, false);
      return void (msg.textContent = humanError(res.error));
    }
    // The day-2 experience is decided here: without this, the first browser restart is a
    // surprise password wall for a password set ten minutes ago.
    await send({ type: 'setKeepUnlocked', enabled: $<HTMLInputElement>('#keep').checked });
    backupView(res.mnemonic);
  };
  $('#go').addEventListener('click', go);
  onEnter('#p1', () => void go());
  onEnter('#p2', () => void go());
  $<HTMLInputElement>('#p1').focus();
}

function backupView(mnemonic: string): void {
  protectPhrase = true;
  const words = mnemonic.trim().split(/\s+/);
  app.innerHTML = `
    <main class="fade">
      <p class="kicker">Step 2 of 3</p>
      <h1>Back up your recovery phrase</h1>
      <p class="lead">These ${words.length} words are the only way to restore your identity on another device.</p>
      <div class="card">
        <div class="words">${words
          .map((w, i) => `<div class="w"><span class="n">${i + 1}</span><span class="t">${esc(w)}</span></div>`)
          .join('')}</div>
        <button id="copy" class="btn icon" style="margin-top:10px">${I.copy}<span>Copy</span></button>
        <div class="warnline">Write these down and store them offline. Anyone with them can restore your identity; we cannot recover them for you — but you can view them again anytime in Ekko’s settings on this browser.</div>
        <label class="ck"><input id="saved" type="checkbox" /> I’ve saved my recovery phrase</label>
      </div>
      <button id="go" class="btn primary block" disabled>Continue</button>
    </main>`;
  $('#copy').addEventListener('click', () => {
    void navigator.clipboard.writeText(words.join(' ')).then(() => {
      const btn = $('#copy');
      btn.innerHTML = `${I.check}<span>Copied</span>`;
      setTimeout(() => (btn.innerHTML = `${I.copy}<span>Copy</span>`), 1400);
    });
  });
  $<HTMLInputElement>('#saved').addEventListener('change', (e) => {
    const saved = (e.target as HTMLInputElement).checked;
    protectPhrase = !saved;
    $<HTMLButtonElement>('#go').disabled = !saved;
  });
  $('#go').addEventListener('click', () => modeView());
}

// The fork, the same one the site leads with: claim a handle, or stay a ghost. Both are real and
// both finish. The handle road passes through registration first — a handle lives on an account,
// and there is deliberately no way to pick one without signing in. The account buys discovery and
// nothing else: the keys already exist, in this browser, and the ghost road costs no crypto.
function modeView(): void {
  protectPhrase = false;
  accountWatch = null;
  app.innerHTML = `
    <main class="fade">
      <p class="kicker">Two ways to use it</p>
      <h1>Claim a handle. Or stay a ghost.</h1>
      <button id="connect" class="card mode">
        <span class="mode-title">@you, everywhere</span>
        <span class="mode-body">Claim your handle once, link your socials, and add friends everywhere. They find your public key automatically. Every app you share becomes a sealed channel.</span>
        <span class="mode-note">Sign in with Google or email</span>
      </button>
      <button id="offgrid" class="card mode">
        <span class="mode-title">Off the grid</span>
        <span class="mode-body">No handle, no sign-in, nothing to join. Your keys stay in this browser and you trade invites directly with the people you trust. We never even learn you exist.</span>
        <span class="mode-note">No account, ever</span>
      </button>
      <p class="hint center">Either way your keys never leave this device. Connect an account or go dark later, from the Ekko popup.</p>
    </main>`;
  $('#offgrid').addEventListener('click', () => doneView());
  $('#connect').addEventListener('click', () => {
    // Already signed in (a restore, or a second run) skips the gate it has already passed.
    void send({ type: 'acctStatus' }).then((s) => (s.signedIn ? handleView() : signInView()));
  });
}

// Registration, and only registration: the handle screen is behind it. Google or the emailed
// code — both land on the same account, because Supabase links by email.
function signInView(): void {
  app.innerHTML = `
    <main class="fade">
      <p class="kicker">Your handle</p>
      <h1>First, an account</h1>
      <p class="lead">A handle needs somewhere to live. Your account holds it, and the people you connect with. It never holds your keys — those stay in this browser.</p>
      ${signInCardHTML()}
      <button id="back" class="btn ghost block">Back</button>
    </main>`;
  wireSignInCard(() => handleView());
  $('#back').addEventListener('click', modeView);
}

// The payoff of registering: the handle. Reachable only signed in — a restored account may
// already own one, in which case the claim form would only ever answer "taken", so show it.
function handleView(kicker = 'Step 3 of 3'): void {
  protectPhrase = false;
  accountWatch = null;
  app.innerHTML = `
    <main class="fade">
      <p class="kicker">${kicker}</p>
      <h1>Pick your handle</h1>
      <p class="lead">People find you at your handle instead of trading invites by hand. First claim wins.</p>
      <div class="card">
        <label class="field" for="handle">Your handle</label>
        <div class="handle-in"><span class="at">@</span><input id="handle" placeholder="yourname" autocomplete="off" maxlength="20" /></div>
        <div id="msg" class="msg err" role="alert"></div>
      </div>
      <button id="go" class="btn primary block">Claim handle</button>
      <button id="skip" class="btn ghost block">Skip for now</button>
    </main>`;
  $('#skip').addEventListener('click', () => doneView());
  const go = async () => {
    const h = $<HTMLInputElement>('#handle').value.trim().replace(/^@/, '').toLowerCase();
    const msg = $('#msg');
    if (!HANDLE_RE.test(h)) return void (msg.textContent = 'Handles are 3–20 lowercase letters, numbers or _.');
    msg.textContent = '';
    const btn = $<HTMLButtonElement>('#go');
    setBusy(btn, true);
    const res = await send({ type: 'acctClaim', handle: h });
    if (res.error) {
      setBusy(btn, false);
      return void (msg.textContent =
        res.error === 'signed-out' ? 'The sign-in expired — go back and sign in again.' : humanError(res.error));
    }
    // Publish this key onto the account and pull any people already connected to it, so the
    // handle is findable the moment the tab closes. Best effort; the popup syncs again anyway.
    await send({ type: 'acctSync' });
    doneView(res.handle ?? h);
  };
  $('#go').addEventListener('click', go);
  onEnter('#handle', () => void go());
  $<HTMLInputElement>('#handle').focus();

  // A restored account may already own a handle — show it instead of the claim form.
  void send({ type: 'acctStatus' }).then((s) => {
    if (!s.handle || !$('#handle')) return;
    app.innerHTML = `
      <main class="fade">
        <p class="kicker">${kicker}</p>
        <h1>You are @${esc(s.handle)}</h1>
        <p class="lead">This account already owns its handle. People find you there, and every device you sign in on answers to it.</p>
        <button id="go" class="btn primary block">Finish</button>
      </main>`;
    $('#go').addEventListener('click', () => doneView(s.handle));
  });
}

function doneView(username?: string): void {
  protectPhrase = false;
  const pitch = inviteMessage(username);
  app.innerHTML = `
    <main class="fade">
      <div class="hero">
        <div class="done-ic">${I.check}</div>
        <h1>Ekko is ready</h1>
        <p>Your identity is set up on this device.${username ? ` People find you as <strong>@${esc(username)}</strong>.` : ''}</p>
      </div>
      <div class="card">
        <h2 style="margin-top:0">Bring one friend</h2>
        <p class="muted" style="margin:4px 0 8px">Private messaging takes two. Send this to the person you text most:</p>
        <div class="pitch">${esc(pitch)}</div>
        <button id="copyPitch" class="btn icon block" style="margin-top:8px">${I.copy}<span>Copy message</span></button>
      </div>
      <p class="muted center">Then open a direct message on Instagram, WhatsApp, Telegram or Messenger — Ekko will be there. You can close this tab.</p>
    </main>`;
  $('#copyPitch').addEventListener('click', () => {
    void navigator.clipboard.writeText(pitch).then(() => {
      const btn = $('#copyPitch');
      btn.innerHTML = `${I.check}<span>Copied — paste it in any chat</span>`;
      setTimeout(() => (btn.innerHTML = `${I.copy}<span>Copy message</span>`), 2000);
    });
  });
}

function importView(): void {
  app.innerHTML = `
    <main class="fade">
      <p class="kicker">Restore</p>
      <h1>Restore your identity</h1>
      <p class="lead">Enter the 24-word recovery phrase you saved when you first set up Ekko.</p>
      <div class="card">
        <label class="field" for="phrase">Recovery phrase</label>
        <textarea id="phrase" name="recovery-phrase" placeholder="Enter your 24 words…" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
        <label class="field" for="p1">New password for this device</label>
        ${pwField('p1', 'Password (min. 8 characters)', 'new-password')}
        ${pwField('p2', 'Repeat password', 'new-password')}
        <label class="ck" style="margin-top:10px"><input id="keep" type="checkbox" checked />
          Keep me unlocked on this device. Ekko is ready when your browser starts; your computer's login is the lock. Untick on a shared computer.</label>
        <div id="msg" class="msg err" role="alert"></div>
      </div>
      <button id="go" class="btn primary block">Restore</button>
      <button id="back" class="btn ghost block">Back</button>
    </main>`;
  wireEyes();
  $('#back').addEventListener('click', welcome);
  const go = async () => {
    const phrase = $<HTMLTextAreaElement>('#phrase').value.trim().toLowerCase().replace(/\s+/g, ' ');
    const p1 = $<HTMLInputElement>('#p1').value;
    const p2 = $<HTMLInputElement>('#p2').value;
    const msg = $('#msg');
    if (!phrase) return void (msg.textContent = 'Enter your recovery phrase.');
    if (p1.length < 8) return void (msg.textContent = 'Use at least 8 characters.');
    if (p1 !== p2) return void (msg.textContent = 'Passwords don’t match.');
    msg.textContent = '';
    const btn = $<HTMLButtonElement>('#go');
    setBusy(btn, true);
    const res = await send({ type: 'importIdentity', passphrase: p1, mnemonic: phrase });
    if (res.error) {
      if (res.error === 'vault-exists') return alreadySetUp();
      setBusy(btn, false);
      return void (msg.textContent =
        res.error === 'bad-phrase' ? 'That recovery phrase isn’t valid — check the words and spacing.' : humanError(res.error));
    }
    await send({ type: 'setKeepUnlocked', enabled: $<HTMLInputElement>('#keep').checked });
    modeView();
  };
  $('#go').addEventListener('click', go);
  onEnter('#p1', () => void go());
  onEnter('#p2', () => void go());
  $<HTMLTextAreaElement>('#phrase').focus();
}

function alreadySetUp(): void {
  app.innerHTML = `
    <main class="fade">
      <div class="hero">
        <span class="logo">${I.logo}</span>
        <h1>Ekko is already set up</h1>
        <p>This device already has an Ekko identity. Open Ekko from your browser’s toolbar to use it.</p>
      </div>
      <p class="muted center">You can close this tab.</p>
    </main>`;
}

// ————— entry —————

async function init(): Promise<void> {
  const s = await send({ type: 'status' });
  if (s.error === 'unreachable') {
    app.innerHTML = `<main><div class="card center"><p class="muted">Ekko couldn’t reach its background service. Reload this tab.</p></div></main>`;
    return;
  }
  if (s.state !== 'no-vault') return alreadySetUp();
  welcome();
}

window.addEventListener('beforeunload', (event) => {
  if (!protectPhrase) return;
  event.preventDefault();
  event.returnValue = '';
});

void init();
