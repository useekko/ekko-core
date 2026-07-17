import { DatabaseSync } from 'node:sqlite';

// SQLite via Node's built-in driver — no native build, ideal for a small VPS container.
// Tables: public key bundles (by fingerprint), one optional username claim per key, and
// the launch waitlist (bare emails, single-purpose, deleted after invites go out).
export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS keys (
      fingerprint TEXT PRIMARY KEY,
      invite      TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usernames (
      username    TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS waitlist (
      email      TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    -- No bug_reports table: reports live in Supabase now, written by the Cloudflare worker
    -- (worker/waitlist). Pre-2026-07-11 rows stay in this file until someone drops them.
    -- v2 directory: an account (user) owns an @handle, one or more device key bundles, and
    -- opt-in platform-handle mappings. Publishing is authenticated (ownership proof) and a
    -- lost device rotates to a new bundle under the same user via the recovery key.
    CREATE TABLE IF NOT EXISTS users (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      username        TEXT UNIQUE,        -- the Ekko @handle (optional)
      recovery_fp     TEXT,              -- sha256(recovery bundle), for recovery lookup
      recovery_bundle TEXT,              -- the recovery identity's public bundle
      created_at      INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      bundle     TEXT NOT NULL,           -- device identity invite (EKK1I:…)
      added_at   INTEGER NOT NULL,
      revoked_at INTEGER                  -- null = active
    );
    CREATE TABLE IF NOT EXISTS platform_handles (
      handle_hash TEXT PRIMARY KEY,       -- sha256('instagram:alice'), never the plaintext
      user_id     INTEGER NOT NULL,
      platform    TEXT NOT NULL,
      verified_at INTEGER,                -- null = unverified TOFU
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS key_log (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      bundle_hash TEXT NOT NULL,
      prev_hash  TEXT,                    -- hash-chained transparency (audited later)
      created_at INTEGER NOT NULL
    );
    -- Platform ownership verification: one-time codes a user proves by sending them to the
    -- Ekko bot FROM the platform account being claimed (see docs/DIRECTORY.md). The code is
    -- stored hashed; verified_handle holds the bot-observed plaintext handle only between
    -- consumption and the owner's one-shot fetch, so the at-rest window is minutes.
    CREATE TABLE IF NOT EXISTS verification_codes (
      code_hash   TEXT PRIMARY KEY,
      check_id    TEXT UNIQUE NOT NULL,   -- capability the requester polls with
      user_id     INTEGER NOT NULL,
      platform    TEXT NOT NULL,
      expires_at  INTEGER NOT NULL,
      consumed_at INTEGER,
      verified_handle TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
    CREATE INDEX IF NOT EXISTS idx_users_recovery ON users(recovery_fp);
    CREATE INDEX IF NOT EXISTS idx_codes_user ON verification_codes(user_id, platform);
  `);

  const putKeyStmt = db.prepare(
    `INSERT INTO keys(fingerprint, invite, created_at) VALUES(?, ?, ?)
     ON CONFLICT(fingerprint) DO UPDATE SET invite = excluded.invite`,
  );
  const getKeyStmt = db.prepare('SELECT invite FROM keys WHERE fingerprint = ?');
  const getUserStmt = db.prepare('SELECT fingerprint FROM usernames WHERE username = ?');
  const getNameStmt = db.prepare('SELECT username FROM usernames WHERE fingerprint = ?');
  const putUserStmt = db.prepare('INSERT INTO usernames(username, fingerprint, created_at) VALUES(?, ?, ?)');
  const resolveStmt = db.prepare(
    `SELECT u.fingerprint AS fingerprint, k.invite AS invite
     FROM usernames u JOIN keys k ON k.fingerprint = u.fingerprint
     WHERE u.username = ?`,
  );

  const putWaitlistStmt = db.prepare(
    'INSERT INTO waitlist(email, created_at) VALUES(?, ?) ON CONFLICT(email) DO NOTHING',
  );
  // v2 directory statements.
  const userByNameStmt = db.prepare('SELECT id FROM users WHERE username = ?');
  const userByRecoveryStmt = db.prepare('SELECT id, username FROM users WHERE recovery_fp = ?');
  const insUserStmt = db.prepare('INSERT INTO users(username, recovery_fp, recovery_bundle, created_at) VALUES(?, ?, ?, ?)');
  const insDeviceStmt = db.prepare('INSERT INTO devices(user_id, bundle, added_at) VALUES(?, ?, ?)');
  const revokeDevicesStmt = db.prepare('UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL');
  const activeDeviceStmt = db.prepare('SELECT bundle FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1');
  const activeByNameStmt = db.prepare(
    `SELECT d.bundle AS bundle FROM users u JOIN devices d ON d.user_id = u.id
     WHERE u.username = ? AND d.revoked_at IS NULL ORDER BY d.id DESC LIMIT 1`,
  );
  // First-claim-wins: an unverified platform handle can't be silently overwritten by another
  // account (that would be worse than the legacy TOFU first-come). Cross-account transfer is
  // reserved for the future verified-handle path (verified_at) — see DIRECTORY.md.
  const upsertHandleStmt = db.prepare(
    `INSERT INTO platform_handles(handle_hash, user_id, platform, created_at) VALUES(?, ?, ?, ?)
     ON CONFLICT(handle_hash) DO NOTHING`,
  );
  const handleOwnerStmt = db.prepare('SELECT user_id FROM platform_handles WHERE handle_hash = ?');
  const resolveHandleHashStmt = db.prepare(
    `SELECT d.bundle AS bundle, h.verified_at AS verified_at
     FROM platform_handles h JOIN devices d ON d.user_id = h.user_id
     WHERE h.handle_hash = ? AND d.revoked_at IS NULL ORDER BY d.id DESC LIMIT 1`,
  );
  const userByDeviceStmt = db.prepare('SELECT user_id FROM devices WHERE bundle = ? AND revoked_at IS NULL LIMIT 1');
  const lastKeyLogStmt = db.prepare('SELECT bundle_hash FROM key_log WHERE user_id = ? ORDER BY seq DESC LIMIT 1');
  const insKeyLogStmt = db.prepare('INSERT INTO key_log(user_id, bundle_hash, prev_hash, created_at) VALUES(?, ?, ?, ?)');
  // Verification codes + the verified-handle write path.
  const delCodesForStmt = db.prepare('DELETE FROM verification_codes WHERE user_id = ? AND platform = ?');
  const sweepCodesStmt = db.prepare('DELETE FROM verification_codes WHERE expires_at < ? AND consumed_at IS NULL');
  const insCodeStmt = db.prepare(
    'INSERT INTO verification_codes(code_hash, check_id, user_id, platform, expires_at) VALUES(?, ?, ?, ?, ?)',
  );
  const codeByHashStmt = db.prepare('SELECT code_hash, user_id, platform, expires_at, consumed_at FROM verification_codes WHERE code_hash = ?');
  const consumeCodeStmt = db.prepare(
    'UPDATE verification_codes SET consumed_at = ?, verified_handle = ? WHERE code_hash = ? AND consumed_at IS NULL',
  );
  const codeByCheckStmt = db.prepare(
    'SELECT platform, expires_at, consumed_at, verified_handle FROM verification_codes WHERE check_id = ?',
  );
  const clearCheckHandleStmt = db.prepare('UPDATE verification_codes SET verified_handle = NULL WHERE check_id = ?');
  const delHandleByHashStmt = db.prepare('DELETE FROM platform_handles WHERE handle_hash = ?');
  const delHandlesForStmt = db.prepare('DELETE FROM platform_handles WHERE user_id = ? AND platform = ?');
  const insVerifiedHandleStmt = db.prepare(
    'INSERT INTO platform_handles(handle_hash, user_id, platform, verified_at, created_at) VALUES(?, ?, ?, ?, ?)',
  );
  const userByIdStmt = db.prepare('SELECT id, username FROM users WHERE id = ?');

  return {
    putKey: (fp, invite, now) => putKeyStmt.run(fp, invite, now),
    getKey: (fp) => getKeyStmt.get(fp),
    // Idempotent: a duplicate signup is indistinguishable from a new one to the caller.
    addWaitlist: (email, now) => putWaitlistStmt.run(email, now),
    // First-come username: free -> claim; already yours -> ok; second name -> no.
    claimUsername: (username, fp, now) => {
      const row = getUserStmt.get(username);
      if (row) return row.fingerprint === fp ? 'ok' : 'taken';
      if (getNameStmt.get(fp)) return 'already-claimed';
      putUserStmt.run(username, fp, now);
      return 'ok';
    },
    resolveUsername: (username) => resolveStmt.get(username),

    // —— v2 directory: accounts, devices, platform handles, recovery ——
    usernameTaken: (username) => !!userByNameStmt.get(username),
    userIdByUsername: (username) => userByNameStmt.get(username),
    // Create an account atomically: user + first device + first key-log entry. Returns the
    // new user id, or 'taken' if the @handle is already claimed.
    createAccount: (username, recoveryFp, recoveryBundle, deviceBundle, deviceHash, now) => {
      // One authoritative username namespace: reject if EITHER a v2 account or a legacy
      // (unauthenticated /keys) claim already holds the name, so v2 can't shadow a legacy @handle.
      if (username && (userByNameStmt.get(username) || getUserStmt.get(username))) return 'taken';
      const userId = Number(insUserStmt.run(username ?? null, recoveryFp, recoveryBundle, now).lastInsertRowid);
      insDeviceStmt.run(userId, deviceBundle, now);
      insKeyLogStmt.run(userId, deviceHash, null, now);
      return { userId };
    },
    // Resolve an @handle to its account's current active device bundle.
    resolveHandle: (username) => activeByNameStmt.get(username),
    userByRecoveryFp: (fp) => userByRecoveryStmt.get(fp),
    userByDeviceBundle: (bundle) => userByDeviceStmt.get(bundle),
    activeBundle: (userId) => activeDeviceStmt.get(userId),
    // 'linked' when the handle now points at this user (including an idempotent re-link);
    // 'taken' when first-claim-wins kept it on another account — the caller must not lie.
    linkPlatformHandle: (userId, platform, handleHash, now) => {
      const r = upsertHandleStmt.run(handleHash, userId, platform, now);
      if (r.changes > 0) return 'linked';
      return handleOwnerStmt.get(handleHash)?.user_id === userId ? 'linked' : 'taken';
    },
    resolveByHandleHash: (handleHash) => resolveHandleHashStmt.get(handleHash),
    // Key rotation / recovery: revoke the old device(s), add the new bundle, extend the
    // hash-chained key log — all under the same account, so the @handle survives.
    rotateDevice: (userId, newBundle, newHash, now) => {
      revokeDevicesStmt.run(now, userId);
      insDeviceStmt.run(userId, newBundle, now);
      const prev = lastKeyLogStmt.get(userId);
      insKeyLogStmt.run(userId, newHash, prev?.bundle_hash ?? null, now);
    },

    // —— platform ownership verification ——
    userById: (id) => userByIdStmt.get(id),
    // One active code per (user, platform): issuing replaces any earlier one. Expired
    // never-consumed codes are swept opportunistically here so the table stays bounded.
    issueCode: (userId, platform, codeHash, checkId, expiresAt, now) => {
      sweepCodesStmt.run(now);
      delCodesForStmt.run(userId, platform);
      insCodeStmt.run(codeHash, checkId, userId, platform, expiresAt);
    },
    codeByHash: (codeHash) => codeByHashStmt.get(codeHash),
    // Marks the code consumed and parks the bot-observed plaintext handle for the owner's
    // one-shot fetch. Returns false when a concurrent consumer got there first.
    consumeCode: (codeHash, handle, now) => consumeCodeStmt.run(now, handle, codeHash).changes > 0,
    codeByCheckId: (checkId) => codeByCheckStmt.get(checkId),
    clearCheckHandle: (checkId) => clearCheckHandleStmt.run(checkId),
    // The ONLY path that writes verified_at. A fresh platform-asserted proof of control wins:
    // it displaces any earlier claim to the same handle (verified or not — the platform just
    // told us who controls the account NOW) and retires the prover's stale mappings for the
    // same platform, so a renamed account doesn't leave a verified ghost behind.
    verifyPlatformHandle: (userId, platform, handleHash, now) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        delHandleByHashStmt.run(handleHash);
        delHandlesForStmt.run(userId, platform);
        insVerifiedHandleStmt.run(handleHash, userId, platform, now, now);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    // A user removes their own mapping(s) for a platform. Returns how many rows went away.
    unlinkPlatform: (userId, platform) => delHandlesForStmt.run(userId, platform).changes,
    // Admin razor: remove a mapping whoever owns it (abuse reports, support).
    deleteHandleByHash: (handleHash) => delHandleByHashStmt.run(handleHash).changes,
    handleOwner: (handleHash) => handleOwnerStmt.get(handleHash),

    close: () => db.close(),
  };
}
