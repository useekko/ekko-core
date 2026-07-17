// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderBubble } from '../src/content/dom.js';

// The in-chat rendering is the surface that keeps breaking (raw ciphertext, then the token
// showing NEXT TO the decrypted text). These pin the invariant: after render, the bubble shows
// ONLY our decrypted content, whatever DOM shape the messenger wrapped the token in.
describe('renderBubble blanks the platform token however deeply it is nested', () => {
  const token = 'RSN1M:AQG6lDacWvRfMOXlYPYu0S7vBKZH6kuTQMHyiHxsNVgjcjnJQOpz6JzFtNBTAI4sZBXi5M8';

  it('direct-child text (Instagram-style)', () => {
    const el = document.createElement('span');
    el.textContent = token;
    renderBubble(el, 'Hey', 'decrypted');
    expect(el.textContent).toBe('Hey'); // NOT "RSN1M:… Hey"
    expect(el.querySelector('.rsn-content')?.textContent).toBe('Hey');
  });

  it('deeply nested text (Meta/WhatsApp/Telegram wrapper spans) — the "token \\n Hey" bug', () => {
    const el = document.createElement('div');
    el.innerHTML = `<span><span><span>${token}</span></span></span>`;
    renderBubble(el, 'Hey', 'decrypted');
    expect(el.textContent).toBe('Hey');
  });

  it('does not clobber the decrypted text or a revealed ciphertext on re-render', () => {
    const el = document.createElement('div');
    el.innerHTML = `<span>${token}</span>`;
    renderBubble(el, 'Hey', 'decrypted');
    // simulate the user clicking the lock to reveal what actually crossed the wire
    const content = el.querySelector<HTMLElement>('.rsn-content')!;
    content.textContent = token;
    content.classList.add('rsn-cipher');
    // a re-scan renders a DIFFERENT state (info) — the blanking must skip our own nodes
    renderBubble(el, 'Secure channel established', 'info');
    expect(el.textContent).toBe('Secure channel established');
  });

  it('two voices: the lock trails a decrypted message, chrome chips lead with their icon', () => {
    const el = document.createElement('span');
    el.textContent = token;
    renderBubble(el, 'Hey', 'decrypted');
    expect(el.lastElementChild?.classList.contains('rsn-badge')).toBe(true);
    expect(el.classList.contains('rsn-system')).toBe(false);
    renderBubble(el, 'Encrypted — unlock Ekko to read', 'pending');
    expect(el.firstElementChild?.classList.contains('rsn-badge')).toBe(true);
    expect(el.classList.contains('rsn-system')).toBe(true);
  });

  it('the focus-pull animation class arrives with decryption, not with the pending cover', () => {
    const el = document.createElement('span');
    el.textContent = token;
    renderBubble(el, 'Encrypted message', 'pending');
    const content = el.querySelector<HTMLElement>('.rsn-content')!;
    expect(content.classList.contains('rsn-in')).toBe(false);
    renderBubble(el, 'Hey', 'decrypted');
    expect(content.classList.contains('rsn-in')).toBe(true);
  });

  it('a bubble born decrypted (own sent message, cache-served re-mount) renders still — no animation', () => {
    const el = document.createElement('span');
    el.textContent = token;
    renderBubble(el, 'Hey', 'decrypted');
    expect(el.querySelector<HTMLElement>('.rsn-content')!.classList.contains('rsn-in')).toBe(false);
  });

  it('hushes an empty info bubble (a replayed handshake) instead of showing an empty badge', () => {
    const el = document.createElement('div');
    el.innerHTML = `<span>RSN1C:abc:1/4:RSN1H:xyz</span>`;
    renderBubble(el, '', 'info');
    expect(el.classList.contains('rsn-hush')).toBe(true);
    expect(el.querySelector('.rsn-content')).toBeNull();
    expect(el.querySelector('.rsn-badge')).toBeNull();
  });
});
