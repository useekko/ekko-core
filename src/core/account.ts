// The Ekko account, from the browser extension. The same account the iOS app signs into
// (ios/Ekko/EkkoAccountClient.swift), talking to the same Supabase project, so one identity can
// live in both places — which is the whole point: the extension and the app are interchangeable.
//
// Sign-in here is the EMAILED 8-DIGIT CODE, not Google. Not a limitation so much as a choice:
// Google in an extension means `chrome.identity.launchWebAuthFlow`, the `identity` permission, and
// registering a chromiumapp.org redirect. The code path is a plain fetch, needs no new permission
// beyond reaching Supabase, and lands on the SAME account a Google sign-in on the phone creates
// (Supabase links by email). Sign in with Google on the phone, with a code in the browser, and it
// is one account with one backup.
//
// The Supabase URL and anon key are public by design — they ship inside the account web page too.
// Row-level security is the enforcement, and the session JWT is the identity.
import type { BackupBlob } from './backup.js';

export const SUPABASE_URL = 'https://hkcohnjgyutarjoongbb.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhrY29obmpneXV0YXJqb29uZ2JiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2OTQ3MzEsImV4cCI6MjA5OTI3MDczMX0.vjSghWu4_DxHCJqsHCEthPfn-7FXvVXMp6vSZA-BxRI';

export interface AccountSession {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

export class AccountError extends Error {}

/** The membership oracle is deliberate for a private alpha: an uninvited email learns it is one. */
function mapError(status: number, body: unknown): AccountError {
  const o = (body ?? {}) as Record<string, unknown>;
  const text = ['error_code', 'code', 'msg', 'message', 'error_description']
    .map((k) => (typeof o[k] === 'string' ? (o[k] as string) : ''))
    .join(' ')
    .toLowerCase();
  if (text.includes('signup') || text.includes('otp_disabled')) {
    return new AccountError('This alpha is invite only.');
  }
  if (text.includes('expired') || text.includes('otp') || text.includes('token')) {
    return new AccountError('That code expired. Ask for a fresh one.');
  }
  if (status === 401 || status === 403) return new AccountError('Not allowed.');
  return new AccountError(text || `Server error ${status}`);
}

async function call(path: string, init: RequestInit & { token?: string } = {}): Promise<unknown> {
  const { token, ...rest } = init;
  const res = await fetch(SUPABASE_URL + path, {
    ...rest,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(rest.headers ?? {}),
    },
  });
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) throw mapError(res.status, body);
  return body;
}

function sessionFrom(o: Record<string, unknown>): AccountSession {
  const accessToken = o['access_token'];
  const refreshToken = o['refresh_token'];
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
    throw new AccountError('The server did not return a session.');
  }
  const expiresIn = typeof o['expires_in'] === 'number' ? o['expires_in'] : 3600;
  return { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 };
}

/** Emails a one-time link AND an 8-digit code to an INVITED address. `create_user: false` is what
 *  keeps registration closed: a stranger gets `signup_disabled`, not an account. */
export async function sendCode(email: string): Promise<void> {
  await call('/auth/v1/otp', {
    method: 'POST',
    body: JSON.stringify({ email, create_user: false }),
  });
}

export async function verifyCode(email: string, code: string): Promise<AccountSession> {
  const body = await call('/auth/v1/verify', {
    method: 'POST',
    body: JSON.stringify({ type: 'email', email, token: code.trim() }),
  });
  return sessionFrom(body as Record<string, unknown>);
}

export async function refreshSession(s: AccountSession): Promise<AccountSession> {
  const body = await call('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: s.refreshToken }),
  });
  return sessionFrom(body as Record<string, unknown>);
}

/** Refresh with five minutes to spare, so the next call is not the one that discovers it expired. */
export async function validSession(s: AccountSession): Promise<AccountSession> {
  return s.expiresAt - Date.now() > 5 * 60_000 ? s : refreshSession(s);
}

export function emailOf(s: AccountSession): string | null {
  const claims = jwtClaims(s.accessToken);
  return typeof claims?.['email'] === 'string' ? (claims['email'] as string) : null;
}

export function userIdOf(s: AccountSession): string | null {
  const claims = jwtClaims(s.accessToken);
  return typeof claims?.['sub'] === 'string' ? (claims['sub'] as string) : null;
}

function jwtClaims(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// --- @handle -> public key, and the people you are connected to ---
//
// The account carries your PUBLIC key now. That is not a weakening of anything: an invite is a
// public key, the product already trades it over channels it does not trust, and there is no private
// material in it to leak. What it buys is the thing the product was missing — being connected to
// someone means you can encrypt to them, with no invite to paste.
//
// What this does NOT have, and the standalone key directory did: a proof that you hold the private key for
// what you publish. RLS only proves you own the ROW. So you can publish a key you do not control —
// onto your own profile, where the only person it hurts is you. The safety number remains the thing
// that makes a key really theirs. See docs/ACCOUNTS.md.

export interface AccountProfile {
  userId: string;
  handle: string;
  displayName: string | null;
  publicKey: string | null;
  // The peer's linked messenger handles (platform -> handle, normalized), from their
  // account_handles. RLS only lets accepted connections read these; undefined until
  // connectionEdges attaches them.
  handles?: Record<string, string>;
}

interface ProfileRow {
  user_id: string;
  handle: string;
  display_name: string | null;
  public_key: string | null;
}

const asProfile = (r: ProfileRow): AccountProfile => ({
  userId: r.user_id,
  handle: r.handle,
  displayName: r.display_name,
  publicKey: r.public_key,
});

/** nil until a handle is claimed — the key hangs off the profile row, and there is no row before that. */
export async function myProfile(s: AccountSession): Promise<AccountProfile | null> {
  const uid = userIdOf(s);
  if (!uid) throw new AccountError('Not signed in.');
  const rows = (await call(
    `/rest/v1/profiles?user_id=eq.${uid}&select=user_id,handle,display_name,public_key`,
    { token: s.accessToken },
  )) as ProfileRow[];
  return rows[0] ? asProfile(rows[0]) : null;
}

/** Claim the account @handle — the same POST the iOS app's claimHandle makes. First claim wins
 *  server-side (unique index + grammar CHECK); the raw Postgres noise those return is translated
 *  here so callers can put the message straight in front of a person. */
export async function claimHandle(s: AccountSession, handle: string): Promise<AccountProfile> {
  const uid = userIdOf(s);
  if (!uid) throw new AccountError('Not signed in.');
  let rows: ProfileRow[];
  try {
    rows = (await call('/rest/v1/profiles', {
      method: 'POST',
      token: s.accessToken,
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({ user_id: uid, handle }),
    })) as ProfileRow[];
  } catch (e) {
    const text = e instanceof Error ? e.message : '';
    if (text.includes('23505') || text.includes('duplicate')) {
      // profiles_pkey means THIS account already has a row (claim raced a sync); anything else
      // duplicate is the handle's unique index — someone got there first.
      throw new AccountError(
        text.includes('profiles_pkey')
          ? 'This account already has a handle.'
          : 'That handle is taken — try another.',
      );
    }
    if (text.includes('profiles_handle_check') || text.includes('23514')) {
      throw new AccountError('Handles are 3–20 lowercase letters, numbers or _.');
    }
    throw e;
  }
  if (!rows[0]) throw new AccountError('The server did not return the claimed handle.');
  return asProfile(rows[0]);
}

/** Publish this device's public key against your handle. */
export async function publishKey(s: AccountSession, invite: string): Promise<void> {
  const uid = userIdOf(s);
  if (!uid) throw new AccountError('Not signed in.');
  await call(`/rest/v1/profiles?user_id=eq.${uid}`, {
    method: 'PATCH',
    token: s.accessToken,
    body: JSON.stringify({ public_key: invite }),
  });
}

interface EdgeRow {
  id: string;
  status: string;
  requester: string;
  addressee: string;
  requester_profile: ProfileRow | null;
  addressee_profile: ProfileRow | null;
}

export interface ConnectionEdge {
  connectionId: string;
  accepted: boolean;
  iRequested: boolean;
  peer: AccountProfile;
}

/** Every connection you are party to, with the other person's profile. Pending edges are
 *  included — the REQUESTER stages session setup before acceptance — so callers gate on
 *  `accepted` before treating a peer as consented-to. */
export async function connectionEdges(s: AccountSession): Promise<ConnectionEdge[]> {
  const uid = userIdOf(s);
  if (!uid) throw new AccountError('Not signed in.');
  const sel =
    'id,status,requester,addressee,' +
    'requester_profile:profiles!connections_requester_fkey(user_id,handle,display_name,public_key),' +
    'addressee_profile:profiles!connections_addressee_fkey(user_id,handle,display_name,public_key)';
  const rows = (await call(`/rest/v1/connections?select=${sel}`, {
    token: s.accessToken,
  })) as EdgeRow[];
  const edges: ConnectionEdge[] = [];
  for (const r of rows) {
    const p = r.requester === uid ? r.addressee_profile : r.requester_profile;
    if (!p) continue;
    edges.push({
      connectionId: r.id,
      accepted: r.status === 'accepted',
      iRequested: r.requester === uid,
      peer: asProfile(p),
    });
  }
  const peers = edges.filter((e) => e.accepted).map((e) => e.peer);

  // Their linked messenger handles. The account_handles RLS lets an accepted connection read
  // these, and they are the bridge that maps a messenger @handle to this connection — the phone
  // already relies on it (docs/ACCOUNTS-ADMIN.md); the extension now does too. One batched read
  // for everyone we are connected to, normalized (lowercase, no leading @) for direct matching.
  if (peers.length) {
    // Non-fatal: linked handles are a convenience, not the channel. If this read fails (an older
    // server without the table, a hiccup) connections still become contacts by key — just without
    // handle auto-match. It must never take down the key adoption that IS the encrypted channel.
    try {
      const ids = peers.map((p) => p.userId).join(',');
      const socials = (await call(
        `/rest/v1/account_handles?user_id=in.(${ids})&select=user_id,platform,handle`,
        { token: s.accessToken },
      )) as { user_id: string; platform: string; handle: string }[];
      const byUser = new Map<string, Record<string, string>>();
      for (const h of socials) {
        const m = byUser.get(h.user_id) ?? {};
        m[h.platform.toLowerCase()] = String(h.handle).toLowerCase().replace(/^@/, '');
        byUser.set(h.user_id, m);
      }
      for (const p of peers) p.handles = byUser.get(p.userId);
    } catch {
      /* leave peers without handles; the key channel still stands */
    }
  }
  return edges;
}

// --- answering a connection request ---
// Accepting is the consent gate: it is what lets RLS reveal the requester's staged session
// setup and linked socials to you (and yours to them). Mirrors ios/Ekko/EkkoAccountClient.

export async function acceptConnection(s: AccountSession, connectionId: string): Promise<void> {
  // Addressee-only, pending-only (RLS). return=representation so a silent no-op — someone
  // else's row, or already accepted — surfaces as an empty result instead of a fake success.
  const rows = (await call(`/rest/v1/connections?id=eq.${connectionId}`, {
    method: 'PATCH',
    token: s.accessToken,
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({ status: 'accepted', responded_at: new Date().toISOString() }),
  })) as unknown[];
  if (!Array.isArray(rows) || !rows.length) throw new AccountError('Not allowed.');
}

/** Decline, cancel and disconnect are all the same delete (either party may). */
export async function declineConnection(s: AccountSession, connectionId: string): Promise<void> {
  await call(`/rest/v1/connections?id=eq.${connectionId}`, {
    method: 'DELETE',
    token: s.accessToken,
  });
}

// --- session setup through the connection, not the conversation ---
//
// The mailbox that replaced the in-chat EKK1H preamble (`session_setups` in
// scripts/account-setup.mjs). The requester stages PUBLIC handshake material against the
// connection; RLS keeps it invisible to the recipient until they accept. Mirrors
// ios/Ekko/EkkoAccountClient.swift — the two clients must agree, or a channel the phone
// set up never reaches the browser and its messages hang at "waiting for the secure channel".

export interface SessionSetupRow {
  connection_id: string;
  sender: string;
  recipient: string;
  sender_key: string; // hex fingerprint of the bundle the handshake was built FROM
  recipient_key: string; // …and the one it was built TO — a pre-rotation row fails this match
  handshake: string; // EKK1H: token, the same bytes the preamble used to carry
}

export async function sessionSetups(s: AccountSession): Promise<SessionSetupRow[]> {
  const fields = 'connection_id,sender,recipient,sender_key,recipient_key,handshake';
  return (await call(`/rest/v1/session_setups?select=${fields}`, {
    token: s.accessToken,
  })) as SessionSetupRow[];
}

export async function publishSessionSetup(
  s: AccountSession,
  row: Omit<SessionSetupRow, 'sender'>,
): Promise<void> {
  // Upsert on (connection_id, sender): retry and key rotation replace the row instead of
  // accumulating. `sender` is auth.uid() server-side — sending it would be a spoof and RLS
  // would refuse the write.
  await call('/rest/v1/session_setups', {
    method: 'POST',
    token: s.accessToken,
    headers: { prefer: 'return=representation,resolution=merge-duplicates' },
    body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }),
  });
}

// --- the encrypted backup ---
// Only ciphertext crosses this boundary. See backup.ts: the passphrase that opens the blob is never
// sent, so the account can hold your keys without being able to read them.

export async function fetchBackup(s: AccountSession): Promise<BackupBlob | null> {
  const rows = (await call('/rest/v1/key_backups?select=blob', {
    token: s.accessToken,
  })) as { blob: BackupBlob }[];
  return rows[0]?.blob ?? null;
}

export async function uploadBackup(s: AccountSession, blob: BackupBlob): Promise<void> {
  // Upsert: one row per account, so re-backing-up replaces rather than leaving older copies of the
  // identity behind. user_id comes from auth.uid() server-side — sending it would be a spoof and RLS
  // would refuse the write.
  await call('/rest/v1/key_backups', {
    method: 'POST',
    token: s.accessToken,
    headers: { prefer: 'return=representation,resolution=merge-duplicates' },
    body: JSON.stringify({ blob }),
  });
}

export async function deleteBackup(s: AccountSession): Promise<void> {
  const uid = userIdOf(s);
  if (!uid) throw new AccountError('Not signed in.');
  // The filter is mandatory: PostgREST rejects an unfiltered DELETE ("DELETE requires a WHERE
  // clause"), so omitting it is a 400 rather than a wiped table.
  await call(`/rest/v1/key_backups?user_id=eq.${uid}`, {
    method: 'DELETE',
    token: s.accessToken,
  });
}
