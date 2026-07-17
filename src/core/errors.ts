// One place that turns an RPC error code into a sentence a person can act on. Raw codes
// like `no-vault` had been falling through to the UI wherever a screen lacked its own
// dictionary; screens with richer context-specific copy keep it and use this as the
// fallback instead of the bare code.
const HUMAN: Record<string, string> = {
  locked: 'Ekko is locked — open the popup and unlock first.',
  'no-vault': 'No Ekko identity on this browser yet — set one up first.',
  'vault-exists': 'This browser already holds an Ekko identity.',
  'wrong-passphrase': 'Wrong password — try again.',
  'bad-phrase': 'That recovery phrase isn’t valid — check the words and spacing.',
  'bad-invite': 'That doesn’t look like a valid Ekko invite.',
  'thats-you': 'That’s your own identity.',
  'unknown-contact': 'That contact isn’t in your list anymore.',
  'no-such-contact': 'That contact isn’t in your list anymore.',
  'bad-handle': 'That doesn’t look right — check the username.',
  'bad-platform': 'That app isn’t supported.',
  'bad-username': 'Handles are 3–20 lowercase letters, numbers or _.',
  'username-taken': 'That handle is taken.',
  'username-exists': 'This identity already has a handle.',
  'handle-taken': 'Another Ekko identity already linked that account.',
  'no-handle': 'Claim your @handle first.',
  'no-account': 'No account found for this identity.',
  'no-phrase': 'This older identity has no recovery phrase.',
  'no-backup': 'There’s no backup on this account yet.',
  'bad-backup': 'That backup can’t be opened — check the passphrase.',
  'bad-proof': 'Couldn’t prove your key to the directory — try again.',
  'directory-insecure': 'Couldn’t reach the directory securely — try again later.',
  'directory-unreachable': 'Couldn’t reach the directory — check your connection and try again.',
  'directory-error': 'The directory had a problem — try again.',
  'verify-unavailable': 'Automatic verification for this app isn’t live yet.',
  'verify-expired': 'That code expired — start verification again.',
  'not-found': 'Nothing found by that name.',
  'not-signed-in': 'Sign in to your Ekko account first.',
  'signed-out': 'The sign-in expired — sign in again.',
  'invite-only': 'Registration is invite-only right now.',
  'rate-limited': 'Too many tries — wait a minute and try again.',
  unreachable: 'Ekko couldn’t reach its background service — close and reopen this window.',
};

export function humanError(code: string | undefined): string {
  if (!code) return 'Something went wrong — try again.';
  return HUMAN[code] ?? `Something went wrong — try again. (${code})`;
}
