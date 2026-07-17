import { describe, expect, it } from 'vitest';
import {
  BACKUP_VERSION,
  BackupError,
  MIN_PASSPHRASE_LENGTH,
  PBKDF2_ITERATIONS,
  generatePassphrase,
  openBackup,
  sealBackup,
} from '../src/core/backup.js';
import { b64uEncode } from '../src/core/b64.js';
import { generateMnemonic } from '../src/core/recovery.js';

// The encrypted backup is the one artefact of Ekko's that is allowed to sit on someone else's
// disk. Every test here is a way of asking the same question: can the party holding it learn
// anything, or change it without us noticing?

const PASS = 'correct horse battery staple';

function payload() {
  return {
    mnemonic: generateMnemonic(),
    contacts: [
      { bundle: b64uEncode(new Uint8Array([1, 2, 3])), label: 'Mara', verified: true, addedAt: 1 },
    ],
  };
}

describe('backup round trip', () => {
  it('opens with the right passphrase and returns exactly what went in', () => {
    const p = payload();
    const opened = openBackup(sealBackup(p, PASS), PASS);
    expect(opened.mnemonic).toBe(p.mnemonic);
    expect(opened.contacts).toEqual(p.contacts);
    expect(opened.v).toBe(BACKUP_VERSION);
  });

  it('refuses the wrong passphrase rather than returning junk', () => {
    const blob = sealBackup(payload(), PASS);
    expect(() => openBackup(blob, PASS + 'x')).toThrow(BackupError);
  });

  it('gives a different blob every time, so equal vaults are not equal ciphertext', () => {
    const p = payload();
    const a = sealBackup(p, PASS);
    const b = sealBackup(p, PASS);
    // Same plaintext, same passphrase — if these matched, the server could tell two people (or two
    // points in time) apart by comparing bytes.
    expect(a.ct).not.toBe(b.ct);
    expect(a.salt).not.toBe(b.salt);
    expect(a.nonce).not.toBe(b.nonce);
  });
});

describe('the blob gives nothing away', () => {
  it('leaks neither the phrase nor a contact label into the ciphertext', () => {
    const p = payload();
    const blob = sealBackup(p, PASS);
    // Check the VALUES, not the whole envelope: its constant field names collide with real
    // BIP-39 words (a drawn "once" is a substring of "nonce", "salt" is a field) and made
    // this flake on unlucky mnemonics.
    const wire = [blob.salt, blob.nonce, blob.ct].join(' ');
    for (const word of p.mnemonic.split(' ')) expect(wire).not.toContain(word);
    expect(wire).not.toContain('Mara');
  });
});

describe('a hostile server cannot rewrite the header', () => {
  // The KDF parameters travel in the clear, so the only thing stopping a server from handing back
  // `iter: 1` is that they are authenticated. If this test ever goes green with the AAD removed,
  // the backup is downgradeable to a key an attacker can brute-force in an afternoon.
  it('rejects a lowered iteration count', () => {
    const blob = sealBackup(payload(), PASS);
    expect(() => openBackup({ ...blob, iter: 1 }, PASS)).toThrow(BackupError);
  });

  it('rejects a swapped KDF name', () => {
    const blob = sealBackup(payload(), PASS);
    expect(() => openBackup({ ...blob, kdf: 'md5' }, PASS)).toThrow(BackupError);
  });

  it('rejects a tampered ciphertext', () => {
    const blob = sealBackup(payload(), PASS);
    const ct = b64uEncode(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(() => openBackup({ ...blob, ct }, PASS)).toThrow(BackupError);
  });

  it('refuses an iteration count that would hang the device', () => {
    const blob = sealBackup(payload(), PASS);
    expect(() => openBackup({ ...blob, iter: 1_000_000_000 }, PASS)).toThrow(BackupError);
  });

  it('refuses a future format instead of guessing at it', () => {
    const blob = sealBackup(payload(), PASS);
    expect(() => openBackup({ ...blob, v: 99 }, PASS)).toThrow(BackupError);
  });

  // Postgres `jsonb` does not preserve key order — a blob stored as {v,kdf,iter,salt,nonce,ct}
  // comes back as {v,ct,…}. That is survivable ONLY because the authenticated header is rebuilt
  // from the field VALUES, never from the stored JSON text. If someone ever "optimises" the AAD to
  // be the raw bytes of the envelope, every backup on every server silently stops opening, and
  // this test is what stops them.
  it('still opens after a store has reordered the envelope keys', () => {
    const blob = sealBackup(payload(), PASS);
    const reordered = JSON.parse(
      JSON.stringify({
        ct: blob.ct,
        v: blob.v,
        nonce: blob.nonce,
        iter: blob.iter,
        salt: blob.salt,
        kdf: blob.kdf,
      }),
    );
    expect(openBackup(reordered, PASS).contacts[0]?.label).toBe('Mara');
  });
});

describe('passphrases', () => {
  it('will not seal behind a passphrase too short to be worth the encryption', () => {
    expect(() => sealBackup(payload(), 'short')).toThrow(BackupError);
    expect('a'.repeat(MIN_PASSPHRASE_LENGTH).length).toBe(MIN_PASSPHRASE_LENGTH);
  });

  it('generates six distinct-enough words, and they actually open a backup', () => {
    const phrase = generatePassphrase();
    expect(phrase.split(' ')).toHaveLength(6);
    expect(phrase.length).toBeGreaterThanOrEqual(MIN_PASSPHRASE_LENGTH);
    // Two calls must not agree, or the "entropy" is theatre.
    expect(generatePassphrase()).not.toBe(phrase);

    const p = payload();
    expect(openBackup(sealBackup(p, phrase), phrase).mnemonic).toBe(p.mnemonic);
  });

  it('states the iteration count it actually used, so a client can refuse a weak one', () => {
    expect(sealBackup(payload(), PASS).iter).toBe(PBKDF2_ITERATIONS);
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600_000);
  });
});
