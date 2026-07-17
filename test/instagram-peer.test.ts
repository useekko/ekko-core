// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { InstagramAdapter } from '../src/content/instagram.js';

// Instagram peer detection, pinned against BOTH layouts Meta actually ships:
//   - desktop web  : peer link inside <main>, self in the left nav rail
//   - mobile web   : peer link in a top bar OUTSIDE <main>, self in the bottom tab bar
//
// The mobile case is a real 2026-07-13 capture (peer "peer.demo" at y=16, self "demo1"
// in the bottom tab bar at y=618). Before the structural-nav fix it stuck on "identifying this
// chat" forever: <main>-based self/peer detection grabbed the peer as "self", so no peer remained
// and isDirectChat() returned null. This is the regression guard for that.
//
// jsdom has no layout engine, so geometry is fed from a data-top attribute and every element is
// forced visible. Positions only need to be ORDERED correctly, which is all the adapter reads.

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

function at(url: string, body: string) {
  history.replaceState(null, '', url);
  document.body.innerHTML = body;
  return new InstagramAdapter();
}

describe('Instagram peer detection — mobile web (the "identifying this chat" bug)', () => {
  // Exactly the shape the capture showed.
  const mobile = `
    <div id="topbar"><a role="link" href="/peer.demo/" data-top="16">peer.demo</a></div>
    <div id="thread">
      <a role="link" href="/peer.demo" data-top="154"></a>
      <div role="textbox" contenteditable="true" aria-label="Message" data-top="600"></div>
    </div>
    <nav id="tabbar">
      <a role="link" href="/explore/" data-top="618"></a>
      <a role="link" href="/reels/" data-top="618"></a>
      <a role="link" href="/demo1/" data-top="618"></a>
    </nav>`;

  it('reads the peer from the top bar, not the tab bar', () => {
    const ig = at('/direct/t/18068790812430202/', mobile);
    expect(ig.peerHandle()).toBe('peer.demo');
    expect(ig.peerName()).toBe('peer.demo');
  });

  it('confirms a 1:1 instead of stalling on null', () => {
    const ig = at('/direct/t/18068790812430202/', mobile);
    expect(ig.isDirectChat()).toBe(true); // the whole point: not null
  });

  it('never mistakes your own tab-bar profile for the peer', () => {
    // If self-detection regressed to "first profile link", peerHandle would be the peer's own
    // handle excluded and this would go null or wrong.
    const ig = at('/direct/t/18068790812430202/', mobile);
    expect(ig.peerHandle()).not.toBe('demo1');
  });

  it('works when a semantic main excludes the header/composer and compact nav routes differ', () => {
    const ig = at(
      '/direct/t/18068790812430202/',
      `<div id="topbar"><a role="link" href="/peer.demo/" data-top="16">peer.demo</a></div>
       <main id="scroller">
         <a role="link" href="/shared_post_author/" data-top="154">shared_post_author</a>
         <div dir="auto" data-top="210">ordinary message</div>
       </main>
       <form id="composer"><textarea placeholder="Message..." data-top="560">draft</textarea></form>
       <nav id="compact-tabbar">
         <a role="link" href="/" data-top="618"></a>
         <a role="link" href="/direct/inbox/" data-top="618"></a>
         <a role="link" href="/reels/" data-top="618"></a>
         <a role="link" href="/demo1/" data-top="618"></a>
       </nav>`,
    );
    expect(ig.peerHandle()).toBe('peer.demo');
    expect(ig.isDirectChat()).toBe(true);
    expect(ig.readComposer()).toBe('draft');
  });

  it('does not exclude the peer as self when only one recognizable nav route is mounted', () => {
    const ig = at(
      '/direct/t/18068790812430202/',
      `<div id="topbar"><a role="link" href="/peer.demo/" data-top="16">rabbit</a></div>
       <main><a role="link" href="/peer.demo/" data-top="154"></a></main>
       <textarea placeholder="Message..." data-top="560"></textarea>
       <nav><a role="link" href="/reels/" data-top="618"></a><a role="link" href="/demo1/" data-top="618"></a></nav>`,
    );
    expect(ig.peerHandle()).toBe('peer.demo');
    expect(ig.isDirectChat()).toBe(true);
  });

  it('ignores one-segment links on external hosts', () => {
    const ig = at(
      '/direct/t/18068790812430202/',
      `<a role="link" href="https://example.com/im-not-the-peer" data-top="4">external</a>
       <a role="link" href="/peer.demo/" data-top="16">rabbit</a>
       <textarea placeholder="Message..." data-top="560"></textarea>`,
    );
    expect(ig.peerHandle()).toBe('peer.demo');
  });
});

describe('Instagram peer detection — desktop web (no regression)', () => {
  // Desktop: <main> holds the header + thread, the left rail (with explore/reels + self) is outside.
  const desktop = `
    <nav id="rail">
      <a role="link" href="/explore/" data-top="200"></a>
      <a role="link" href="/reels/" data-top="260"></a>
      <a role="link" href="/demo1/" data-top="700"></a>
    </nav>
    <main>
      <div id="header"><a role="link" href="/peer.demo/" data-top="16">peer.demo</a></div>
      <div id="thread">
        <a role="link" href="/peer.demo" data-top="154"></a>
        <div role="textbox" contenteditable="true" aria-label="Message" data-top="600"></div>
      </div>
    </main>`;

  it('still finds the peer inside <main> and confirms the 1:1', () => {
    const ig = at('/direct/t/18068790812430202/', desktop);
    expect(ig.peerHandle()).toBe('peer.demo');
    expect(ig.isDirectChat()).toBe(true);
  });
});

describe('Instagram peer detection — group and non-DM stay safe', () => {
  it('a group (two distinct peers in the top bar) is NOT reported as a 1:1', () => {
    const ig = at(
      '/direct/t/999/',
      `<div id="topbar" style="">
         <a role="link" href="/alice/" data-top="16">alice</a>
         <a role="link" href="/bob/" data-top="16">bob</a>
       </div>
       <div role="textbox" contenteditable="true" aria-label="Message" data-top="600"></div>
       <nav><a role="link" href="/explore/" data-top="618"></a><a role="link" href="/reels/" data-top="618"></a><a role="link" href="/demo1/" data-top="618"></a></nav>`,
    );
    expect(ig.isDirectChat()).toBe(false); // two peers on the header row → not 1:1
  });

  it('outside a DM thread there is no peer at all', () => {
    const ig = at(
      '/direct/inbox/',
      `<nav><a role="link" href="/explore/" data-top="618"></a><a role="link" href="/reels/" data-top="618"></a><a role="link" href="/demo1/" data-top="618"></a></nav>`,
    );
    expect(ig.isDirectChat()).toBe(false); // no /direct/t/<id> → definitely not a 1:1
    expect(ig.peerHandle()).toBeNull();
  });
});

describe('Instagram message/composer DOM — iOS Safari', () => {
  it('recognizes mobile div[dir] ciphertext and ignores duplicate wrappers', () => {
    const ig = at(
      '/direct/t/123/',
      `<div id="topbar"><a role="link" href="/alice/" data-top="16">Alice</a></div>
       <section id="conversation">
         <div dir="ltr" id="outer" data-top="220"><span dir="auto" id="inner" data-top="220">EKK1M:mobile-token</span></div>
         <div dir="auto" data-top="260">ordinary Instagram text</div>
         <textarea placeholder="Message..." data-top="560"></textarea>
       </section>`,
    );
    expect(ig.findBubbles().map((b) => b.id)).toEqual(['inner']);
  });

  it('scopes desktop ciphertext to the conversation pane, not inbox previews', () => {
    const ig = at(
      '/direct/t/123/',
      `<nav><a role="link" href="/explore/" data-top="200"></a><a role="link" href="/reels/" data-top="260"></a><a role="link" href="/me/" data-top="700"></a></nav>
       <main>
         <aside><div dir="auto" id="preview" data-top="110">EKK1M:preview-token</div></aside>
         <section id="conversation">
           <a role="link" href="/alice/" data-top="16">Alice</a>
           <div dir="auto" id="bubble" data-top="220">EKK1M:conversation-token</div>
           <div role="textbox" contenteditable="true" data-top="560"></div>
         </section>
       </main>`,
    );
    expect(ig.findBubbles().map((b) => b.id)).toEqual(['bubble']);
  });

  it('injects through the native textarea setter and sends with Enter', async () => {
    const ig = at(
      '/direct/t/123/',
      `<a role="link" href="/alice/" data-top="16">Alice</a>
       <textarea id="box" placeholder="Message..." data-top="560">private draft</textarea>`,
    );
    const box = document.querySelector<HTMLTextAreaElement>('#box')!;
    let inputEvents = 0;
    box.addEventListener('input', () => inputEvents++);
    box.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter' && box.value === 'EKK1M:sealed') box.value = '';
    });

    await expect(ig.injectAndSend('EKK1M:sealed')).resolves.toBeUndefined();
    expect(inputEvents).toBeGreaterThan(0);
    expect(box.value).toBe('');
  });

  it('accepts a successful mobile editor remount only after the outgoing token appears', async () => {
    const ig = at(
      '/direct/t/123/',
      `<section id="conversation">
         <a role="link" href="/alice/" data-top="16">Alice</a>
         <textarea id="box" placeholder="Message..." data-top="560">private draft</textarea>
       </section>`,
    );
    const box = document.querySelector<HTMLTextAreaElement>('#box')!;
    box.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key !== 'Enter') return;
      const replacement = document.createElement('textarea');
      replacement.placeholder = 'Message...';
      replacement.setAttribute('data-top', '560');
      const echo = document.createElement('div');
      echo.dir = 'auto';
      echo.id = 'echo';
      echo.textContent = box.value;
      box.replaceWith(echo, replacement);
    });

    await expect(ig.injectAndSend('EKK1M:remounted')).resolves.toBeUndefined();
    expect(document.querySelector('#echo')?.textContent).toBe('EKK1M:remounted');
  });

  it('restores the plaintext draft when a contenteditable rejects both insertion paths', async () => {
    const ig = at(
      '/direct/t/123/',
      `<a role="link" href="/alice/" data-top="16">Alice</a>
       <div id="box" role="textbox" contenteditable="true" data-top="560">private draft</div>`,
    );
    const box = document.querySelector<HTMLElement>('#box')!;
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false });
    box.addEventListener('input', () => {
      if (box.textContent === 'EKK1M:rejected') box.textContent = 'private draft';
    });

    try {
      await expect(ig.injectAndSend('EKK1M:rejected')).rejects.toThrow('send-failed');
      expect(box.textContent).toBe('private draft');
    } finally {
      delete (document as unknown as { execCommand?: unknown }).execCommand;
    }
  });

  it('intercepts a semantic form submit even when the localized send button has no English label', () => {
    const ig = at(
      '/direct/t/123/',
      `<a role="link" href="/alice/" data-top="16">Alice</a>
       <form id="composer"><textarea placeholder="Message..." data-top="560">secret</textarea><button type="submit">Enviar</button></form>`,
    );
    let handled = '';
    ig.onSend({
      shouldHandle: () => true,
      handle: async (text) => {
        handled = text;
      },
    });
    const form = document.querySelector<HTMLFormElement>('#composer')!;
    const event = new SubmitEvent('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(handled).toBe('secret');
  });
});
