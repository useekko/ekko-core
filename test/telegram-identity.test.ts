import { describe, expect, it } from 'vitest';
import { pickTelegramIdentity } from '../src/content/telegram.js';

// The peer's @username / phone are picked out of a Telegram Web user record. The two web clients
// store the same facts under different field names/shapes, so the picker has to normalize both.
describe('Telegram pickTelegramIdentity', () => {
  it('WebK/tweb raw MTProto: legacy `username` + digits `phone`', () => {
    expect(pickTelegramIdentity({ _: 'user', username: 'A_N_D_R_E_vVv', phone: '79067051810' })).toEqual({
      username: 'a_n_d_r_e_vvv',
      phone: '79067051810',
    });
  });

  it('WebA/telegram-tt camelCase: active collectible `usernames[]` + `phoneNumber`', () => {
    const rec = {
      firstName: 'Zert',
      phoneNumber: '+44 20 7946 0000',
      usernames: [
        { username: 'old_dead', isActive: false },
        { username: 'ZertLive', isActive: true },
      ],
    };
    expect(pickTelegramIdentity(rec)).toEqual({ username: 'zertlive', phone: '442079460000' });
  });

  it('WebK collectible `usernames[]` with pFlags.active', () => {
    const rec = {
      _: 'user',
      usernames: [
        { _: 'username', username: 'inactive_one', pFlags: {} },
        { _: 'username', username: 'Chosen', pFlags: { active: true } },
      ],
    };
    expect(pickTelegramIdentity(rec).username).toBe('chosen');
  });

  it('falls back to the first username when none is flagged active', () => {
    expect(pickTelegramIdentity({ usernames: [{ username: 'firstish' }] }).username).toBe('firstish');
  });

  it('phone hidden by Telegram (empty/absent) yields null, username still resolves', () => {
    expect(pickTelegramIdentity({ username: 'nophone', phoneNumber: '' })).toEqual({
      username: 'nophone',
      phone: null,
    });
  });

  it('no username and no phone (a peer with neither exposed) is all null', () => {
    expect(pickTelegramIdentity({ _: 'user', firstName: 'Anon' })).toEqual({ username: null, phone: null });
  });

  it('rejects a junk phone and a non-object record', () => {
    expect(pickTelegramIdentity({ phone: 'not-a-number' }).phone).toBeNull();
    expect(pickTelegramIdentity(null)).toEqual({ username: null, phone: null });
    expect(pickTelegramIdentity('nope')).toEqual({ username: null, phone: null });
  });
});
