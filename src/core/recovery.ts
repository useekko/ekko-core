// Seed-phrase recovery (wallet-style). A 12-word BIP39 mnemonic is the account-free backup:
// it deterministically derives both the recovery key (which authorizes rotating your device
// key while keeping your @handle) and each device key. Write the phrase down once and you can
// restore your identity — and reclaim your handle — on a new device, no account, no server
// secret. The phrase never leaves the device except as words the user chooses to record.
import { generateMnemonic as bip39Generate, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { identityFromKeyMaterial } from './crypto.js';
import type { Identity } from './crypto.js';

const KDF_SALT = new TextEncoder().encode('Ekko/recovery/v1');
const RECOVERY_PATH = 'recovery';
const devicePath = (index: number) => `device/${index}`;

// 24 words = 256-bit entropy. Deliberately stronger than a wallet's usual 12: every key here
// is DERIVED from this seed, so the seed's entropy caps the derived keys' security. 128 bits
// would cap a seed-derived ML-KEM-768 key at ~2^64 under Grover — undercutting the whole
// post-quantum, harvest-now-decrypt-later promise. 256 bits keeps the full PQ margin.
export function generateMnemonic(): string {
  return bip39Generate(wordlist, 256);
}

export function isValidMnemonic(phrase: string): boolean {
  return validateMnemonic(normalizeMnemonic(phrase), wordlist);
}

// Lowercase, collapse whitespace — tolerant of how a user re-types their words.
export function normalizeMnemonic(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Derive a full identity for a named path from the phrase's 64-byte seed. HKDF gives clean
// domain separation, so the recovery key and each device key are independent: 32 bytes for
// the X25519 scalar, 64 for the ML-KEM seed.
function deriveIdentity(seed: Uint8Array, path: string): Identity {
  const out = hkdf(sha256, seed, KDF_SALT, new TextEncoder().encode(path), 96);
  return identityFromKeyMaterial(out.slice(0, 32), out.slice(32, 96));
}

export function seedFromMnemonic(phrase: string): Uint8Array {
  return mnemonicToSeedSync(normalizeMnemonic(phrase));
}

// The recovery key: a fixed derivation that never rotates. Its private half proves you own
// the phrase; the directory stores its public bundle as the account-free recovery anchor.
export function recoveryIdentity(phrase: string): Identity {
  return deriveIdentity(seedFromMnemonic(phrase), RECOVERY_PATH);
}

// The device key at a rotation index (0 = first). Losing a device → derive the next index
// from the same phrase and prove control of the recovery key to bind it to your handle.
export function deviceIdentity(phrase: string, index = 0): Identity {
  return deriveIdentity(seedFromMnemonic(phrase), devicePath(index));
}
