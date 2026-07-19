import { describe, it, expect } from 'vitest';
import { inviteLink, inviteMessage } from '../src/core/growth.js';
import { IG_MAX_MESSAGE_LEN } from '../src/core/wire.js';

describe('invite links and the message that carries them', () => {
  it('inviteLink: handle-form when a handle exists, token-form for a ghost, homepage otherwise', () => {
    expect(inviteLink('kirill')).toBe('https://useekko.app/i#@kirill');
    // A handle is short and stable, so it wins over the long token even when both are known.
    expect(inviteLink('kirill', 'EKK1I:xyz')).toBe('https://useekko.app/i#@kirill');
    expect(inviteLink(undefined, 'EKK1I:xyz')).toBe('https://useekko.app/i#EKK1I:xyz');
    expect(inviteLink()).toBe('https://useekko.app');
  });

  it('IG length gating: a handle link always fits; a ghost token link degrades to the plain pitch', () => {
    const token = 'EKK1I:' + 'A'.repeat(1650); // a real invite is ~1,630 chars — over IG's 900 cap
    expect(token.length).toBeGreaterThan(IG_MAX_MESSAGE_LEN);

    // A handle link is short: it fits the tightest composer and is carried verbatim.
    const handleMsg = inviteMessage('kirill', token, IG_MAX_MESSAGE_LEN);
    expect(handleMsg).toContain('https://useekko.app/i#@kirill');
    expect(handleMsg.length).toBeLessThanOrEqual(IG_MAX_MESSAGE_LEN);

    // A ghost's token link blows the cap → fall back to the plain pitch; no giant link pasted.
    const ghostGated = inviteMessage(undefined, token, IG_MAX_MESSAGE_LEN);
    expect(ghostGated).not.toContain(token);
    expect(ghostGated).not.toContain('/i#EKK1I:');
    expect(ghostGated.length).toBeLessThanOrEqual(IG_MAX_MESSAGE_LEN);
    expect(ghostGated).toContain('https://useekko.app'); // still points them at Ekko

    // Unconstrained (a clipboard copy, no cap): the ghost link IS carried, so the friend lands
    // holding the key and can add them in a tap.
    const ghostFull = inviteMessage(undefined, token);
    expect(ghostFull).toContain('https://useekko.app/i#' + token);
  });
});
