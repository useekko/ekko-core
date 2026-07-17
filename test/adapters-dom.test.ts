// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { WhatsAppAdapter } from '../src/content/whatsapp.js';
import { MessengerAdapter } from '../src/content/messenger.js';
import { TelegramAdapter } from '../src/content/telegram.js';

// DOM fixtures for the three live-tuned adapters (Instagram has its own file). Each fixture
// is the minimal shape the 2026-07-12 live-tuning pass verified against a logged-in session
// (docs/ADAPTERS.md carries selector provenance); these pin the PARSING so a refactor can't
// silently regress what live tuning established. The contract under test is the adapters'
// prime directive: identify the peer or fail VISIBLY (null) — never guess.
//
// jsdom has no layout engine: geometry comes from data-top and everything is forced visible
// (same trick as instagram-peer.test.ts).

const win = globalThis as unknown as { HTMLElement: typeof HTMLElement };
win.HTMLElement.prototype.getBoundingClientRect = function () {
  const top = Number((this as HTMLElement).getAttribute('data-top') ?? 0);
  const left = Number((this as HTMLElement).getAttribute('data-left') ?? 0);
  const width = Number((this as HTMLElement).getAttribute('data-width') ?? 100);
  const height = Number((this as HTMLElement).getAttribute('data-height') ?? 40);
  return { top, bottom: top + height, left, right: left + width, width, height, x: left, y: top, toJSON() {} };
};
win.HTMLElement.prototype.getClientRects = (() => [{}]) as unknown as HTMLElement['getClientRects'];
Object.defineProperty(win.HTMLElement.prototype, 'offsetParent', { configurable: true, get: () => document.body });

afterEach(() => {
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
});

const tick = () => new Promise((r) => setTimeout(r, 0));

// ————— WhatsApp Web —————
// Identity fact from live tuning: the JID left the DOM entirely; the phone lives in
// IndexedDB. jsdom has no indexedDB, which conveniently IS the "DB unavailable" production
// case — the adapter must fall back to the name binding, never hang or guess.

const waChat = (opts: { name?: string; aria?: string; senders?: string[]; msgIds?: string[] } = {}) => {
  const { name = 'Maya Petrova', aria = `Type a message to ${name}`, senders = ['Maya Petrova'], msgIds = [] } = opts;
  document.body.innerHTML = `
    <div id="main">
      <header><span dir="auto">${name}</span></header>
      <div id="log">
        ${senders
          .map(
            (s, i) =>
              `<div class="copyable-text" data-pre-plain-text="[12:0${i}, 7/16/2026] ${s}: " ${msgIds[i] ? `data-id="${msgIds[i]}"` : ''}>
                 <span class="selectable-text">hello ${i}</span></div>`,
          )
          .join('')}
      </div>
      <footer>
        <div contenteditable="true" data-tab="10" aria-label="${aria}"></div>
        <button aria-label="Send"><span data-icon="wds-ic-send-filled"></span></button>
      </footer>
    </div>`;
  return new WhatsAppAdapter();
};

describe('WhatsApp adapter — DOM parsing', () => {
  it('reads the peer name from the header dir=auto span', () => {
    expect(waChat().peerName()).toBe('Maya Petrova');
  });

  it('confirms a 1:1 only when the composer aria carries the peer name', () => {
    expect(waChat().isDirectChat()).toBe(true);
    // Generic composer aria (a group's shape): cannot confirm — null, NEVER true.
    expect(waChat({ aria: 'Type a message' }).isDirectChat()).toBe(null);
    // No open chat at all.
    document.body.innerHTML = '';
    expect(new WhatsAppAdapter().isDirectChat()).toBe(false);
  });

  it('three distinct authors is unambiguously a group', () => {
    const wa = waChat({ senders: ['Maya Petrova', 'Ben', 'Zoe'] });
    expect(wa.isDirectChat()).toBe(false);
  });

  it('threadId stays null (identifying) until the phone lookup has been TRIED, then commits to the name binding', async () => {
    const wa = waChat({ name: 'Мая П', aria: 'Type a message to Мая П', senders: ['Мая П'], msgIds: ['3A0123456789ABCDEF0'] });
    // First ask kicks off the async IndexedDB read; nothing is bound yet.
    expect(wa.threadId()).toBe(null);
    await tick(); // jsdom has no indexedDB → the lookup resolves to "no phone" for every msgid
    await tick();
    // The fallback is the ENCODED display name: a spaced/Cyrillic name raw would fail the
    // scoped-thread-id charset and stick the chat on "identifying" (caught live, v0.6.3).
    expect(wa.threadId()).toBe(`name:${encodeURIComponent('мая п')}`);
    // And the directory is never queried on a display name: no phone = no handle.
    expect(wa.peerHandle()).toBe(null);
  });

  it('pins the thread key so an outgoing message cannot re-identify the chat mid-send', async () => {
    // The 2026-07-17 live bug: threadId prefers the peer PHONE from IndexedDB, and on first
    // contact the FIRST outgoing message (the handshake) is what creates that phone record —
    // so the key flipped name:<peer> → pn:<phone> BETWEEN the handshake and the message of one
    // send. The controller pins the thread across a multi-part send and aborted on the change
    // ("1 of 2 parts went out"), stranding the peer unable to decrypt. threadId now pins the
    // key for the open chat.
    const wa = waChat({ name: 'Maya', aria: 'Type a message to Maya', senders: ['Maya'], msgIds: ['3A0123456789ABCDEF0'] });
    expect(wa.threadId()).toBe(null); // kicks off the async IndexedDB read
    await tick(); // jsdom has no indexedDB → resolves to "no phone" → the name binding
    await tick();
    const pinned = wa.threadId();
    expect(pinned).toBe('name:maya');
    // Now the first message we sent lands: a new msgid whose phone DOES resolve. Seed the
    // adapter's phone cache directly (bypassing the async IndexedDB read jsdom can't run) and
    // put its msgid in the DOM, exactly as a just-sent message would.
    (wa as unknown as { phoneByMsgId: Map<string, string | null> }).phoneByMsgId.set('B1B2C3D4E5F60718', '15551230000');
    const row = document.createElement('div');
    row.setAttribute('data-id', 'B1B2C3D4E5F60718');
    document.getElementById('log')!.appendChild(row);
    // Same open chat → the key must NOT change out from under an in-flight send.
    expect(wa.threadId()).toBe(pinned);
  });

  it('releases the pinned key when the chat actually changes', async () => {
    const wa = waChat({ name: 'Maya', aria: 'Type a message to Maya', senders: ['Maya'], msgIds: ['3A0123456789ABCDEF0'] });
    expect(wa.threadId()).toBe(null); // kicks off the async IndexedDB read
    await tick();
    await tick();
    expect(wa.threadId()).toBe('name:maya');
    // Switch to a different 1:1: the header name and composer aria both change. A stale pin
    // here would bind the new chat under the old peer's key.
    document.querySelector('#main header span[dir="auto"]')!.textContent = 'Ben';
    document.querySelector('#main footer div[contenteditable="true"]')!.setAttribute('aria-label', 'Type a message to Ben');
    await tick();
    await tick();
    expect(wa.threadId()).toBe('name:ben');
  });

  it('finds the send button by aria label and by the renamed icon alone', () => {
    const wa = waChat();
    expect(wa.debugProbe().sendButton).toBe(true);
    // Meta renamed data-icon "send" → "wds-ic-send-filled"; aria may localize away. The icon
    // alone must still resolve to its button.
    document.body.querySelector('button[aria-label="Send"]')!.setAttribute('aria-label', 'Senden');
    expect(new WhatsAppAdapter().debugProbe().sendButton).toBe(true);
  });

  it('scopes bubbles to the chat and never reads the composer as a message', () => {
    const wa = waChat();
    const texts = wa.findBubbles().map((b) => wa.bubbleText(b));
    expect(texts).toEqual(['hello 0']);
  });
});

// ————— WhatsApp Web: the send path —————
// The 2026-07-17 field bug ("couldn't place the encrypted message in the box", flaky):
// WhatsApp re-renders the footer on every empty↔filled swap — which the clear+insert
// itself triggers — and React sometimes replaces the composer NODE mid-send. The old
// path pinned one node for the whole flow and threw whenever it died, including AFTER
// a successful send (the box remounting on send is normal). These tests pin the
// remount-tolerant contract; they drive the real injectAndSend against jsdom fixtures.

const waComposer = () => document.querySelector<HTMLElement>('#main footer div[contenteditable="true"]');

// jsdom implements neither execCommand nor (constructible) DataTransfer/ClipboardEvent.
// The fake targets the CURRENT composer by selector — like the real command targets the
// focused editor — so a remounted node is picked up exactly as in the browser. Faithful to
// the live 2026-07-17 WhatsApp build (and Messenger, the same Lexical editor family):
// selectAll and delete are IGNORED, and insertText REPLACES only what the DOM Selection
// covers, otherwise it stacks onto existing content — exactly the drift that piled tokens
// onto leftover drafts in the field.
const installExecCommand = (
  getBox: () => HTMLElement | null,
  onInsert?: (box: HTMLElement, text: string) => void,
) => {
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: (cmd: string, _ui?: boolean, val?: string) => {
      const box = getBox();
      if (!box) return false;
      if (cmd === 'insertText') {
        if (onInsert) {
          onInsert(box, val ?? '');
          return true;
        }
        const sel = window.getSelection();
        const r = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
        const covers = !!r && (r.commonAncestorContainer === box || box.contains(r.commonAncestorContainer));
        box.textContent = covers ? (val ?? '') : (box.textContent ?? '') + (val ?? '');
      }
      return true;
    },
  });
};

const echoBubble = (text: string) => {
  const row = document.createElement('div');
  row.className = 'copyable-text';
  row.setAttribute('data-pre-plain-text', '[12:09, 7/17/2026] Me: ');
  const span = document.createElement('span');
  span.className = 'selectable-text';
  span.textContent = text;
  row.appendChild(span);
  document.getElementById('log')!.appendChild(row);
};

const remountComposer = (): HTMLElement => {
  const old = waComposer()!;
  const fresh = old.cloneNode(false) as HTMLElement;
  fresh.textContent = '';
  old.replaceWith(fresh);
  return fresh;
};

describe('WhatsApp adapter — remount-tolerant send', () => {
  afterEach(() => {
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });

  it('sends by clicking and resolves when the composer clears', async () => {
    const wa = waChat();
    installExecCommand(waComposer);
    document.querySelector<HTMLElement>('button[aria-label="Send"]')!.addEventListener('click', () => {
      waComposer()!.textContent = '';
    });
    await expect(wa.injectAndSend('EKK1M:happy')).resolves.toBeUndefined();
    expect(waComposer()!.textContent).toBe('');
  });

  it('a composer remount on send counts as delivered once the token echoes in a bubble', async () => {
    const wa = waChat();
    installExecCommand(waComposer);
    // The field bug's shape: send succeeds, WhatsApp replaces the composer node while
    // clearing it. The old code threw send-failed here — after the message went out.
    document.querySelector<HTMLElement>('button[aria-label="Send"]')!.addEventListener('click', () => {
      const sent = waComposer()!.textContent ?? '';
      remountComposer();
      echoBubble(sent);
    });
    await expect(wa.injectAndSend('EKK1M:remount-sent')).resolves.toBeUndefined();
  });

  it('a bare remount with no bubble echo is still an honest failure, and never re-clicks', async () => {
    const wa = waChat();
    installExecCommand(waComposer);
    let clicks = 0;
    document.querySelector<HTMLElement>('button[aria-label="Send"]')!.addEventListener('click', () => {
      clicks++;
      remountComposer(); // node dies, nothing echoes — ambiguous, must NOT read as success
    });
    await expect(wa.injectAndSend('EKK1M:remount-lost')).rejects.toThrow('send-failed');
    // A blind retry against a dead node could duplicate a send that DID go out.
    expect(clicks).toBe(1);
    // The fresh node holds WhatsApp's own draft state — never ours to write into.
    expect(waComposer()!.textContent).toBe('');
  });

  it('retries the insert when the composer remounts mid-place', async () => {
    const wa = waChat();
    let inserts = 0;
    installExecCommand(waComposer, (box, text) => {
      // First insert: React replaces the node before the text lands (mid-insert remount).
      if (++inserts === 1) remountComposer();
      else box.textContent = text;
    });
    document.querySelector<HTMLElement>('button[aria-label="Send"]')!.addEventListener('click', () => {
      waComposer()!.textContent = '';
    });
    await expect(wa.injectAndSend('EKK1M:second-try')).resolves.toBeUndefined();
    expect(inserts).toBeGreaterThan(1);
  });

  it('waits out a footer re-render between chunks instead of failing the next part', async () => {
    const wa = waChat();
    installExecCommand(waComposer);
    // Part N-1's send left the footer mid re-render: no composer in the DOM right now.
    const footer = document.querySelector('footer')!;
    const box = waComposer()!;
    box.remove();
    setTimeout(() => {
      footer.prepend(box);
      document.querySelector<HTMLElement>('button[aria-label="Send"]')!.addEventListener('click', () => {
        waComposer()!.textContent = '';
      });
    }, 150);
    await expect(wa.injectAndSend('EKK1M:next-chunk')).resolves.toBeUndefined();
  });

  it('restores the plaintext draft and fails honestly when the send never happens', async () => {
    const wa = waChat();
    installExecCommand(waComposer);
    waComposer()!.textContent = 'private draft';
    // Send button exists but clicking moves nothing (mid-swap dead zone, forever).
    await expect(wa.injectAndSend('EKK1M:stuck')).rejects.toThrow('send-failed');
    expect(waComposer()!.textContent).toBe('private draft');
  }, 15000);

  it('replaces a leftover draft instead of stacking the token on it', async () => {
    // The 2026-07-17 root cause: WhatsApp made execCommand selectAll/delete no-ops, so the
    // old clear silently failed, the token stacked onto the draft, and the mixed box no
    // longer classified as pure ciphertext — the controller then blocked its own send
    // click. The fix replaces via the DOM Selection; the send must carry ONLY the token.
    const wa = waChat();
    installExecCommand(waComposer);
    waComposer()!.textContent = 'stale draft';
    let sentContent: string | null = null;
    document.querySelector<HTMLElement>('button[aria-label="Send"]')!.addEventListener('click', () => {
      sentContent = waComposer()!.textContent;
      waComposer()!.textContent = '';
    });
    await expect(wa.injectAndSend('EKK1M:pure')).resolves.toBeUndefined();
    expect(sentContent).toBe('EKK1M:pure');
  });

  it('a failed send with no prior draft leaves the box empty, not token-stuck', async () => {
    const wa = waChat();
    installExecCommand(waComposer);
    const box = waComposer()!;
    // The empty-restore path deletes via a synthetic beforeinput over the selection —
    // the one deletion the live Lexical build still honors.
    box.addEventListener('beforeinput', (e) => {
      if ((e as InputEvent).inputType === 'deleteContentBackward') box.textContent = '';
    });
    await expect(wa.injectAndSend('EKK1M:stuck2')).rejects.toThrow('send-failed');
    expect(box.textContent).toBe('');
  }, 15000);
});

// ————— Facebook Messenger —————
// Cleanest identity of the four: the URL carries the conversation id, a scoped profile link
// carries the peer's GLOBAL Facebook id (permanent and mutual).

const msgrChat = (peers: { id: string; name?: string; top: number }[], opts: { aria?: string } = {}) => {
  history.replaceState(null, '', '/t/1000123/');
  document.body.innerHTML = `
    <div role="main">
      <div data-scope="messages_table">
        ${peers
          .map(
            (p) =>
              `<a href="https://www.facebook.com/${p.id}" data-top="${p.top}">${p.name ?? ''}</a>
               <div dir="auto" data-top="${p.top + 10}">message from ${p.id}</div>`,
          )
          .join('')}
      </div>
      <div contenteditable="true" role="textbox" aria-label="${opts.aria ?? 'Message'}" data-top="700"></div>
    </div>`;
  return new MessengerAdapter();
};

describe('Messenger adapter — DOM parsing', () => {
  it('threadId comes from the URL, for plain and e2ee paths alike', () => {
    history.replaceState(null, '', '/t/1000123/');
    expect(new MessengerAdapter().threadId()).toBe('1000123');
    history.replaceState(null, '', '/e2ee/t/424242/');
    expect(new MessengerAdapter().threadId()).toBe('424242');
    history.replaceState(null, '', '/marketplace/');
    expect(new MessengerAdapter().threadId()).toBe(null);
  });

  it('one distinct profile id = 1:1; the topmost (header) link names the peer', () => {
    const m = msgrChat([
      { id: '100001234567890', name: 'Matteo Negri', top: 20 },
      { id: '100001234567890', name: '', top: 300 }, // same person again, deeper in the log
    ]);
    expect(m.isDirectChat()).toBe(true);
    expect(m.peerHandle()).toBe('100001234567890');
    expect(m.peerName()).toBe('Matteo Negri');
  });

  it('several distinct ids = a group; zero rendered = null, never a guess', () => {
    expect(msgrChat([{ id: '111', top: 20 }, { id: '222', top: 60 }]).isDirectChat()).toBe(false);
    history.replaceState(null, '', '/t/1000123/');
    document.body.innerHTML = '<div role="main"></div>';
    expect(new MessengerAdapter().isDirectChat()).toBe(null);
  });

  it('reserved facebook.com paths are not peers', () => {
    const m = msgrChat([{ id: 'marketplace', top: 10 }]);
    // The only "profile" link is /marketplace → not a person → cannot confirm a 1:1.
    expect(m.peerHandle()).toBe(null);
    expect(m.isDirectChat()).toBe(null);
  });

  it('a bare-avatar header still yields a name via the composer aria, across locales', () => {
    const m = msgrChat([{ id: '100001234567890', top: 20 }], { aria: 'Écrire à Matteo' });
    expect(m.peerName()).toBe('Matteo');
  });
});

// ————— Facebook Messenger: the send path —————
// Messenger runs the SAME Meta Lexical editor as WhatsApp, where execCommand
// selectAll/delete were live-proven no-ops (2026-07-17) — a silently-failed clear stacks
// the token on the user's draft and the mixed box no longer classifies as pure ciphertext.
// These tests pin the ported remount-tolerant discipline: exact-token placement via the
// DOM Selection, Enter primary with a click fallback, echo-confirmed remounts, and
// restore-only-over-our-own-token. They drive the real injectAndSend.

const msgrComposer = () =>
  document.querySelector<HTMLElement>('[role="main"] [contenteditable="true"][role="textbox"]');

const msgrSendChat = () => {
  const m = msgrChat([{ id: '100001234567890', name: 'Matteo Negri', top: 20 }]);
  const send = document.createElement('div');
  send.setAttribute('role', 'button');
  send.setAttribute('aria-label', 'Send');
  msgrComposer()!.parentElement!.appendChild(send);
  return m;
};

const msgrEchoBubble = (text: string) => {
  const div = document.createElement('div');
  div.setAttribute('dir', 'auto');
  div.textContent = text;
  document.querySelector('[data-scope="messages_table"]')!.appendChild(div);
};

const msgrRemountComposer = (): HTMLElement => {
  const old = msgrComposer()!;
  const fresh = old.cloneNode(false) as HTMLElement;
  fresh.textContent = '';
  old.replaceWith(fresh);
  return fresh;
};

const onMsgrEnter = (fn: () => void) => {
  document.querySelector('[role="main"]')!.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') fn();
  });
};

describe('Messenger adapter — remount-tolerant send', () => {
  afterEach(() => {
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });

  it('sends by synthetic Enter and resolves when the composer clears', async () => {
    const m = msgrSendChat();
    installExecCommand(msgrComposer);
    onMsgrEnter(() => {
      msgrComposer()!.textContent = '';
    });
    await expect(m.injectAndSend('EKK1M:happy')).resolves.toBeUndefined();
    expect(msgrComposer()!.textContent).toBe('');
  });

  it('replaces a leftover draft instead of stacking the token on it', async () => {
    // The WhatsApp 2026-07-17 root cause, on the shared editor: the old execCommand
    // selectAll clear silently failed and the send went out with draft+token glued.
    const m = msgrSendChat();
    installExecCommand(msgrComposer);
    msgrComposer()!.textContent = 'stale draft';
    let sentContent: string | null = null;
    onMsgrEnter(() => {
      sentContent = msgrComposer()!.textContent;
      msgrComposer()!.textContent = '';
    });
    await expect(m.injectAndSend('EKK1M:pure')).resolves.toBeUndefined();
    expect(sentContent).toBe('EKK1M:pure');
  });

  it('falls back to clicking Send when the synthetic Enter moves nothing', async () => {
    const m = msgrSendChat();
    installExecCommand(msgrComposer);
    document.querySelector<HTMLElement>('[role="button"][aria-label="Send"]')!.addEventListener('click', () => {
      msgrComposer()!.textContent = '';
    });
    await expect(m.injectAndSend('EKK1M:clicked')).resolves.toBeUndefined();
  });

  it('a composer remount on send counts as delivered once the token echoes in a bubble', async () => {
    const m = msgrSendChat();
    installExecCommand(msgrComposer);
    onMsgrEnter(() => {
      const sent = msgrComposer()!.textContent ?? '';
      msgrRemountComposer();
      msgrEchoBubble(sent);
    });
    await expect(m.injectAndSend('EKK1M:remount-sent')).resolves.toBeUndefined();
  });

  it('a bare remount with no echo is an honest failure that never re-fires or writes into the fresh node', async () => {
    const m = msgrSendChat();
    installExecCommand(msgrComposer);
    let clicks = 0;
    document.querySelector<HTMLElement>('[role="button"][aria-label="Send"]')!.addEventListener('click', () => {
      clicks++;
    });
    onMsgrEnter(() => {
      msgrRemountComposer(); // node dies, nothing echoes — ambiguous, must NOT read as success
    });
    await expect(m.injectAndSend('EKK1M:remount-lost')).rejects.toThrow('send-failed');
    // The click door is only safe while the SAME node still holds our token; a dead node
    // could mean the message already left — a click here could duplicate it.
    expect(clicks).toBe(0);
    // The fresh node holds Messenger's own draft state — never ours to write into.
    expect(msgrComposer()!.textContent).toBe('');
  });

  it('waits out a re-render between chunks instead of failing the next part', async () => {
    const m = msgrSendChat();
    installExecCommand(msgrComposer);
    const row = msgrComposer()!.parentElement!;
    const box = msgrComposer()!;
    box.remove();
    setTimeout(() => {
      row.prepend(box);
      onMsgrEnter(() => {
        msgrComposer()!.textContent = '';
      });
    }, 150);
    await expect(m.injectAndSend('EKK1M:next-chunk')).resolves.toBeUndefined();
  });

  it('restores the plaintext draft and fails honestly when the send never happens', async () => {
    const m = msgrSendChat();
    installExecCommand(msgrComposer);
    msgrComposer()!.textContent = 'private draft';
    // Enter does nothing and the Send click moves nothing (dead editor, forever).
    await expect(m.injectAndSend('EKK1M:stuck')).rejects.toThrow('send-failed');
    expect(msgrComposer()!.textContent).toBe('private draft');
  }, 15000);
});

// ————— Telegram Web (WebK + WebA) —————
// Binds on the GLOBAL numeric peer id (positive = user/DM, negative = group/channel) — the
// permanent-identity model; the @username arrives later from IndexedDB and is only the
// directory handle, never the thread key.

describe('Telegram adapter — DOM parsing', () => {
  it('WebK: peer id from the chat header, positive id = 1:1', () => {
    history.replaceState(null, '', '/k/');
    document.body.innerHTML = `
      <div class="chat"><div class="chat-info"><div class="peer-title" data-peer-id="777000111">Maya</div></div></div>`;
    const tg = new TelegramAdapter();
    expect(tg.threadId()).toBe('777000111');
    expect(tg.isDirectChat()).toBe(true);
    expect(tg.peerName()).toBe('Maya');
  });

  it('WebK: negative id = group/channel; open surface without an id = identifying (null)', () => {
    history.replaceState(null, '', '/k/');
    document.body.innerHTML = `<div class="chat"><div class="chat-info"><div class="peer-title" data-peer-id="-100200300">Team</div></div></div>`;
    expect(new TelegramAdapter().isDirectChat()).toBe(false);
    document.body.innerHTML = `<div class="chat"></div>`; // chat surface rendered, id not yet
    expect(new TelegramAdapter().isDirectChat()).toBe(null);
    document.body.innerHTML = ''; // no chat surface at all
    expect(new TelegramAdapter().isDirectChat()).toBe(false);
  });

  it('WebA: peer id from the URL hash, group detected by sign', () => {
    history.replaceState(null, '', '/a/#777000111');
    expect(new TelegramAdapter().threadId()).toBe('777000111');
    expect(new TelegramAdapter().isDirectChat()).toBe(true);
    history.replaceState(null, '', '/a/#-100200300_1');
    expect(new TelegramAdapter().threadId()).toBe('-100200300');
    expect(new TelegramAdapter().isDirectChat()).toBe(false);
  });

  it('WebK fast path: an #@username hash or a t.me header link names the handle without IndexedDB', () => {
    history.replaceState(null, '', '/k/#@Maya_TG');
    expect(new TelegramAdapter().peerHandle()).toBe('maya_tg');
    history.replaceState(null, '', '/k/');
    document.body.innerHTML = `
      <div class="chat"><div class="chat-info">
        <div class="peer-title" data-peer-id="777000111">Maya</div>
        <a href="https://t.me/maya_tg" data-top="30"></a>
      </div></div>`;
    expect(new TelegramAdapter().peerHandle()).toBe('maya_tg');
  });
});
