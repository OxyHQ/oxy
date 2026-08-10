import * as crypto from 'crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DeviceSessionState, SessionAccount } from '@oxyhq/contracts';
import { getDb, type Database } from '../config/postgres';
import { deviceSessionAccounts } from '../db/schema/deviceSessionAccounts';
import { deviceSessions } from '../db/schema/deviceSessions';
import sessionService from './session.service';
import { sha256Hex, base64UrlEncode, timingSafeStringEqual } from './oauthCode.service';
import { logger } from '../utils/logger';

/** Number of random bytes in a raw `deviceSecret` (256-bit). */
const DEVICE_SECRET_BYTES = 32;
/** Lifetime of a provisioned background credential (30 days). */
const BACKGROUND_CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Grace window during which the just-superseded `deviceSecret` is still accepted
 * after a rotation, so a multi-tab race presenting the previous secret is not
 * locked out (rotation-in-use — mirrors the refresh-family single-use-with-grace).
 */
const DEVICE_SECRET_GRACE_MS = 60_000;

/**
 * Anything that can run a query — the pool handle or an open transaction.
 *
 * Every read helper takes one of these so the SAME loader serves an ordinary
 * request and a read INSIDE a transaction. Without it a transactional write
 * would have to re-read through the pool and could observe pre-transaction
 * state, which is exactly the lost update the transactions exist to prevent.
 */
type Queryable = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * One account signed in on one device — a `device_session_accounts` row.
 *
 * `operatedByUserId` is the OPERATOR of a delegated (`account:act_as`) entry and
 * `null` for an ordinary personal account. That null is load-bearing, not
 * incidental: it is the whole distinction between a delegated entry, whose
 * validity is bounded by a live `account:act_as` re-check, and a plain one that
 * carries no such check. Nothing in this module may collapse the two.
 */
interface DeviceAccountRow {
  accountId: string;
  sessionId: string;
  authuser: number;
  operatedByUserId: string | null;
}

/**
 * A device and everything signed in on it — the `device_sessions` row plus its
 * `device_session_accounts` children, which were an embedded array in Mongo.
 */
interface DeviceSessionRow {
  id: string;
  deviceId: string;
  activeAccountId: string | null;
  secretHash: string | null;
  prevSecretHash: string | null;
  prevSecretExpiresAt: Date | null;
  backgroundSecretHash: string | null;
  backgroundSecretAccountId: string | null;
  backgroundSecretExpiresAt: Date | null;
  revision: number;
  updatedAt: Date;
  accounts: DeviceAccountRow[];
}

export function projectState(doc: DeviceSessionRow): DeviceSessionState {
  const accounts: SessionAccount[] = doc.accounts.map((entry) => {
    const account: SessionAccount = {
      accountId: entry.accountId,
      sessionId: entry.sessionId,
      authuser: entry.authuser,
    };
    // Emitted only for a delegated entry, so a personal account never carries a
    // key the client would read as "operated by someone".
    if (entry.operatedByUserId) account.operatedByUserId = entry.operatedByUserId;
    return account;
  });
  return {
    deviceId: doc.deviceId,
    accounts,
    activeAccountId: doc.activeAccountId,
    revision: doc.revision,
    updatedAt: doc.updatedAt.getTime(),
  };
}

function lowestFreeAuthuser(accounts: DeviceAccountRow[]): number {
  const used = new Set(accounts.map((a) => a.authuser));
  let i = 0;
  while (used.has(i)) i += 1;
  return i;
}

export type SwitchActiveResult =
  | { ok: true; state: DeviceSessionState }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'unauthorized'; state: DeviceSessionState };

export type BackgroundMintResult =
  | { ok: true; accessToken: string; expiresAt: string; accountId: string }
  | { ok: false; reason: 'background_credential_invalid' }
  | { ok: false; reason: 'account_not_on_device' };

// `changed` is false only for an idempotent re-register (same account, same
// session) — the cold-boot reload handoff. The route uses it to skip the
// device-state broadcast when nothing actually changed.
export type AddAccountResult = { state: DeviceSessionState; changed: boolean };

class DeviceSessionService {
  /**
   * Read a device and its account set.
   *
   * The account order is `added_at` then `authuser`, which reproduces the Mongo
   * array order this replaced: a fresh add appended, and a re-add rebuilt the
   * array as `[...others, account]` with a fresh `addedAt`, so both landed last.
   * The order is not cosmetic — `signout` elects `remaining[0]` as the next
   * active account, so an unordered read would make that election arbitrary.
   * `authuser` breaks a same-millisecond tie so the result is total.
   */
  private async load(db: Queryable, deviceId: string): Promise<DeviceSessionRow | null> {
    const [device] = await db
      .select({
        id: deviceSessions.id,
        deviceId: deviceSessions.deviceId,
        activeAccountId: deviceSessions.activeAccountId,
        secretHash: deviceSessions.secretHash,
        prevSecretHash: deviceSessions.prevSecretHash,
        prevSecretExpiresAt: deviceSessions.prevSecretExpiresAt,
        backgroundSecretHash: deviceSessions.backgroundSecretHash,
        backgroundSecretAccountId: deviceSessions.backgroundSecretAccountId,
        backgroundSecretExpiresAt: deviceSessions.backgroundSecretExpiresAt,
        revision: deviceSessions.revision,
        updatedAt: deviceSessions.updatedAt,
      })
      .from(deviceSessions)
      .where(eq(deviceSessions.deviceId, deviceId))
      .limit(1);
    if (!device) return null;

    const accounts = await db
      .select({
        accountId: deviceSessionAccounts.accountId,
        sessionId: deviceSessionAccounts.sessionId,
        authuser: deviceSessionAccounts.authuser,
        operatedByUserId: deviceSessionAccounts.operatedByUserId,
      })
      .from(deviceSessionAccounts)
      .where(eq(deviceSessionAccounts.deviceSessionId, device.id))
      .orderBy(asc(deviceSessionAccounts.addedAt), asc(deviceSessionAccounts.authuser));

    return { ...device, accounts };
  }

  /**
   * The device row for `deviceId`, created empty if it does not exist yet.
   *
   * `on conflict do nothing` is the direct analogue of Mongo's
   * `{ upsert: true, $setOnInsert: … }`: a concurrent creator wins harmlessly
   * and both callers go on to read the same row.
   */
  private async ensureDevice(db: Queryable, deviceId: string): Promise<DeviceSessionRow> {
    await db
      .insert(deviceSessions)
      .values({ deviceId })
      .onConflictDoNothing({ target: deviceSessions.deviceId });
    const row = await this.load(db, deviceId);
    if (!row) {
      // Unreachable: the insert above either created the row or found it
      // already there. Throwing beats a non-null assertion — if the invariant
      // ever breaks, it says so instead of failing as a null-property read
      // somewhere further down the mint path.
      throw new Error(`device_sessions row for "${deviceId}" vanished after upsert`);
    }
    return row;
  }

  async getState(deviceId: string): Promise<DeviceSessionState> {
    const db = getDb();
    const existing = await this.load(db, deviceId);
    if (existing) return this.healActiveAccount(existing);
    return projectState(await this.ensureDevice(db, deviceId));
  }

  // Self-heals a device's active account when it is a managed (act_as)
  // account whose operator membership has since been revoked.
  // `resolveActiveToken` already refuses to mint a token for such an account,
  // but without this the dead account keeps sitting in `accounts`/
  // `activeAccountId` forever — the client would durably render "logged in
  // as <org>" while holding the previous account's bearer. One pass only:
  // drop the revoked account via the existing signout cascade and return the
  // healed state; a newly-elected active account is left for the *next*
  // getState call to re-validate rather than re-checked recursively here.
  // Non-managed (personal) active accounts are never touched by this path —
  // a personal account with a transiently-unresolvable access token must not
  // be dropped, only a managed account whose act_as membership check failed.
  private async healActiveAccount(doc: DeviceSessionRow): Promise<DeviceSessionState> {
    const activeId = doc.activeAccountId;
    if (!activeId) return projectState(doc);
    const active = doc.accounts.find((a) => a.accountId === activeId);
    // A NULL `operated_by_user_id` means "not a delegated session". Only a
    // delegated entry is re-checked here; widening this to every entry would
    // drop a personal account on a transient lookup failure.
    if (!active || !active.operatedByUserId) return projectState(doc);
    const validated = await sessionService.validateSessionById(active.sessionId, false);
    if (validated) return projectState(doc);
    logger.info('deviceSession.getState: dropping revoked managed active account', {
      deviceId: doc.deviceId,
      accountId: activeId,
    });
    return this.signout(doc.deviceId, { accountId: activeId });
  }

  // Registering a session into the device set. Reload ≠ sign-in: the client
  // cold-boot handoff calls this on EVERY reload with the RESTORED session to
  // re-register it, so this must be idempotent and must NOT steal the device's
  // active account. Three cases:
  //   1. Same account + SAME session already present  → pure no-op: return the
  //      current state untouched (no active flip, no revision bump, no write).
  //      This is the reload handoff; flipping active here silently reverted a
  //      prior account switch on the next reload.
  //   2. Same account + DIFFERENT session (deliberate re-auth of that account)
  //      → replace the session (deactivating the displaced one), set active,
  //      bump revision.
  //   3. New account (fresh sign-in / first-entry mint) → add, set active, bump.
  async addAccount(
    deviceId: string,
    input: { accountId: string; sessionId: string; operatedByUserId?: string },
    opts?: { activate?: 'always' | 'if-empty' },
  ): Promise<AddAccountResult> {
    // `activate` default 'always' keeps every existing caller (device
    // add/switch, cold-boot handoff) byte-identical. 'if-empty' is the ADD-ONLY
    // attribution semantic used by the device-first login lanes: register the
    // new account into the set but NEVER steal the device's current active
    // selection — it only becomes active when nothing else is.
    const activate = opts?.activate ?? 'always';

    // The session displaced by case 2, deactivated AFTER the transaction
    // commits. Mongo did this before its (non-atomic) write; deferring it means
    // a rolled-back transaction can no longer kill a session that is still
    // referenced, and the observable order — displaced session dead, device set
    // updated — is unchanged.
    let displacedSessionId: string | null = null;

    const result = await getDb().transaction(async (tx) => {
      const current = await this.ensureDevice(tx, deviceId);
      const existing = current.accounts.find((a) => a.accountId === input.accountId);

      // Case 1 — idempotent re-register (the cold-boot reload handoff).
      if (existing && existing.sessionId === input.sessionId) {
        return { state: projectState(current), changed: false };
      }

      // 'if-empty' preserves an existing active account; only claims active when
      // the device currently has none.
      const nextActiveAccountId =
        activate === 'always' || !current.activeAccountId
          ? input.accountId
          : current.activeAccountId;

      const others = current.accounts.filter((a) => a.accountId !== input.accountId);

      // Case 2 — replacing an account's session (re-add with a new sessionId)
      // must deactivate the session it displaces — otherwise a live,
      // server-side session is left dangling with no device-session entry
      // referencing it.
      if (existing) {
        displacedSessionId = existing.sessionId;
        await tx
          .delete(deviceSessionAccounts)
          .where(
            and(
              eq(deviceSessionAccounts.deviceSessionId, current.id),
              eq(deviceSessionAccounts.accountId, input.accountId),
            ),
          );
      }

      await tx.insert(deviceSessionAccounts).values({
        deviceSessionId: current.id,
        accountId: input.accountId,
        sessionId: input.sessionId,
        authuser: lowestFreeAuthuser(others),
        // NULL, never a placeholder: a delegated entry is exactly the one with
        // an operator set, and `''` would read as a delegated entry owned by
        // nobody while also violating the users foreign key.
        operatedByUserId: input.operatedByUserId ?? null,
      });

      await tx
        .update(deviceSessions)
        .set({
          activeAccountId: nextActiveAccountId,
          revision: sql`${deviceSessions.revision} + 1`,
          // A background credential authorizes the session that was present
          // when it was provisioned. Do not let it follow the same account
          // across a re-authentication (or a change of delegated operator).
          ...(existing && current.backgroundSecretAccountId === input.accountId
            ? this.clearedBackgroundCredentialFields()
            : {}),
        })
        .where(eq(deviceSessions.id, current.id));

      const updated = await this.load(tx, deviceId);
      if (!updated) {
        throw new Error(`device_sessions row for "${deviceId}" vanished during addAccount`);
      }
      return { state: projectState(updated), changed: true };
    });

    if (displacedSessionId) {
      try {
        await sessionService.deactivateSession(displacedSessionId);
      } catch (error) {
        logger.warn('deviceSession.addAccount: deactivate replaced session failed', {
          sessionId: displacedSessionId,
          error,
        });
      }
    }

    return result;
  }

  async switchActive(deviceId: string, accountId: string): Promise<SwitchActiveResult> {
    const db = getDb();
    const current = await this.load(db, deviceId);
    const target = current?.accounts.find((a) => a.accountId === accountId);
    if (!current || !target) return { ok: false, reason: 'not_found' };

    // Re-validate the target account's session BEFORE committing the switch.
    // For a managed account this re-checks the operator's act_as membership
    // (ensureManagedSessionAuthorized) and rejects the switch instead of
    // durably pointing the device at an account the caller no longer has
    // authority over (see resolveActiveToken, which does the same check on
    // read but can't undo an already-committed activeAccountId).
    const validated = await sessionService.validateSessionById(target.sessionId, false);
    if (!validated) {
      // The target session is revoked (e.g. the operator's act_as membership
      // was pulled). Leaving it in the device set strands a dead account the
      // device can never switch into. Heal by removing it through the SAME
      // signout cascade a normal removal uses, and return the healed state so
      // the route can broadcast it to the device's other tabs/connections.
      const state = await this.signout(deviceId, { accountId });
      return { ok: false, reason: 'unauthorized', state };
    }

    const updated = await db.transaction(async (tx) => {
      await tx
        .update(deviceSessions)
        .set({ activeAccountId: accountId, revision: sql`${deviceSessions.revision} + 1` })
        .where(eq(deviceSessions.id, current.id));
      return this.load(tx, deviceId);
    });
    if (!updated) return { ok: false, reason: 'not_found' };
    return { ok: true, state: projectState(updated) };
  }

  /**
   * Mint the access token of ONE account of a device. Returns null when the
   * account is not registered on the device or its session is no longer live —
   * the caller must not distinguish the two (see the pinned mint route).
   *
   * Strictly READ-ONLY with respect to the device row: it never touches
   * `activeAccountId` or `revision`, so an identity-bound client can hold a
   * session for a non-active account without any other app on the same device
   * observing a state change.
   */
  async resolveTokenForAccount(state: DeviceSessionState, accountId: string): Promise<{ accessToken: string; expiresAt: string } | null> {
    const account = state.accounts.find((a) => a.accountId === accountId);
    if (!account) return null;
    // Re-validate before minting a token: for a managed-account session this
    // re-checks the operator's act_as membership (ensureManagedSessionAuthorized)
    // and deactivates+rejects a revoked session instead of handing out a token
    // for an account the caller no longer has authority over.
    const validated = await sessionService.validateSessionById(account.sessionId, false);
    if (!validated) return null;
    const token = await sessionService.getAccessToken(account.sessionId);
    if (!token) return null;
    return { accessToken: token.accessToken, expiresAt: token.expiresAt.toISOString() };
  }

  async resolveActiveToken(state: DeviceSessionState): Promise<{ accessToken: string; expiresAt: string } | null> {
    if (!state.activeAccountId) return null;
    return this.resolveTokenForAccount(state, state.activeAccountId);
  }

  async signout(deviceId: string, target: { accountId: string } | { all: true }): Promise<DeviceSessionState> {
    const db = getDb();
    const current = await this.load(db, deviceId);
    if (!current) return this.getState(deviceId);
    const allAccounts = current.accounts;

    let removingIds: Set<string>;
    if ('all' in target) {
      removingIds = new Set(allAccounts.map((a) => a.accountId));
    } else {
      const targetPresent = allAccounts.some((a) => a.accountId === target.accountId);
      if (!targetPresent) return projectState(current);
      removingIds = new Set([target.accountId]);
      // Cascade: signing out an operator's own account must also remove every
      // managed/org account that operator switched into on this device (one
      // level deep — operated accounts can't themselves operate others). This
      // mirrors `device_session_accounts.operated_by_user_id`'s ON DELETE
      // CASCADE, which is the same rule enforced for a delete that never
      // reaches this service.
      for (const a of allAccounts) {
        if (a.operatedByUserId === target.accountId) {
          removingIds.add(a.accountId);
        }
      }
    }

    const removing = allAccounts.filter((a) => removingIds.has(a.accountId));
    for (const a of removing) {
      try {
        await sessionService.deactivateSession(a.sessionId);
      } catch (error) {
        logger.warn('deviceSession.signout: deactivate failed', { sessionId: a.sessionId, error });
      }
    }

    const remaining = allAccounts.filter((a) => !removingIds.has(a.accountId));
    const activeStillPresent = remaining.some((a) => a.accountId === current.activeAccountId);
    const nextActive = activeStillPresent
      ? current.activeAccountId
      : (remaining[0] ? remaining[0].accountId : null);
    const boundBackgroundAccountId = current.backgroundSecretAccountId;
    const shouldClearBackground =
      'all' in target ||
      (boundBackgroundAccountId !== null && removingIds.has(boundBackgroundAccountId));

    // Signout-ALL also revokes the device's `deviceSecret`: clear the secret
    // hashes so a retained secret can never later mint a token for the now-empty
    // set. Single-account signout leaves the secret alone — other accounts on the
    // SAME device still legitimately mint with it.
    //
    // Cleared to NULL, never `''`. Mongo used `$unset`; the Postgres analogue of
    // "absent" is NULL. An empty string is a VALUE — it would collide on
    // `device_sessions_secret_hash_key` across devices, and `getStateBySecret`
    // guards on a non-empty hash, so `''` would also read as "no secret" while
    // occupying the unique slot.
    const clearedSecrets = {
      ...('all' in target
        ? { secretHash: null, prevSecretHash: null, prevSecretExpiresAt: null }
        : {}),
      ...(shouldClearBackground ? this.clearedBackgroundCredentialFields() : {}),
    };

    const updated = await db.transaction(async (tx) => {
      if (removingIds.size > 0) {
        await tx
          .delete(deviceSessionAccounts)
          .where(
            and(
              eq(deviceSessionAccounts.deviceSessionId, current.id),
              inArray(deviceSessionAccounts.accountId, [...removingIds]),
            ),
          );
      }
      await tx
        .update(deviceSessions)
        .set({
          activeAccountId: nextActive,
          revision: sql`${deviceSessions.revision} + 1`,
          ...clearedSecrets,
        })
        .where(eq(deviceSessions.id, current.id));
      return this.load(tx, deviceId);
    });
    if (!updated) {
      throw new Error(`device_sessions row for "${deviceId}" vanished during signout`);
    }
    return projectState(updated);
  }

  /**
   * Detach an account from a device row after its session MIGRATED to another
   * device (see the deviceId migration in `sessionService.createSession`).
   * Removes the account's entry from THIS device's account set so the stale
   * (graveyard) row stops advertising a live-looking account, and deactivates
   * the session the row referenced — UNLESS it is `preserveSessionId`, the
   * session that just moved (which stays active on its new device). Best-effort
   * cleanup: a no-op when the row is absent or the account is not listed. Never
   * throws for a missing account so callers can fire it without guarding.
   */
  async detachMigratedAccount(deviceId: string, accountId: string, preserveSessionId: string): Promise<void> {
    const db = getDb();
    const current = await this.load(db, deviceId);
    if (!current) return;
    const entry = current.accounts.find((a) => a.accountId === accountId);
    if (!entry) return;

    // Deactivate a DIFFERENT (genuinely stale) session the row referenced —
    // never the one that just migrated and is now live on the caller's device.
    if (entry.sessionId && entry.sessionId !== preserveSessionId) {
      try {
        await sessionService.deactivateSession(entry.sessionId);
      } catch (error) {
        logger.warn('deviceSession.detachMigratedAccount: deactivate failed', { sessionId: entry.sessionId, error });
      }
    }

    const remaining = current.accounts.filter((a) => a.accountId !== accountId);
    const activeStillPresent = remaining.some((a) => a.accountId === current.activeAccountId);
    const nextActive = activeStillPresent
      ? current.activeAccountId
      : (remaining[0] ? remaining[0].accountId : null);

    await db.transaction(async (tx) => {
      await tx
        .delete(deviceSessionAccounts)
        .where(
          and(
            eq(deviceSessionAccounts.deviceSessionId, current.id),
            eq(deviceSessionAccounts.accountId, accountId),
          ),
        );
      await tx
        .update(deviceSessions)
        .set({ activeAccountId: nextActive, revision: sql`${deviceSessions.revision} + 1` })
        .where(eq(deviceSessions.id, current.id));
    });
  }

  /**
   * Issue (rotating) the `deviceSecret` bound to a device (zero-cookie
   * transport). Mints a fresh 256-bit secret, stores only its `sha256` in
   * `secret_hash`, and — when a prior secret existed — moves that prior hash into
   * `prev_secret_hash` with a short `prev_secret_expires_at` grace so a concurrent
   * tab presenting the just-superseded secret is not locked out (rotation-in-use).
   *
   * The WRITE is a single conditional `update`; the grace window (not a lock)
   * is the multi-tab concurrency mitigation — mirroring the refresh family. The
   * raw secret is returned to the caller EXACTLY ONCE and is NEVER logged.
   *
   * Returns null when no `device_sessions` row exists for `deviceId` (or it
   * vanished between read and write): a secret is only ever bound to a real
   * device row, never to a phantom device (no upsert).
   */
  async issueDeviceSecret(deviceId: string): Promise<string | null> {
    const db = getDb();
    // Two concurrent rotations (multi-tab mint, parallel sign-ins) must not
    // clobber each other: last-writer-wins would drop the first writer's fresh
    // secret entirely (neither current nor prev). Compare-and-swap on the
    // secretHash we read; on a lost race, re-read once and rotate on top of the
    // winner — the winner's secret then sits in the grace slot, so BOTH clients
    // end up holding a mintable secret.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [current] = await db
        .select({ secretHash: deviceSessions.secretHash })
        .from(deviceSessions)
        .where(eq(deviceSessions.deviceId, deviceId))
        .limit(1);
      if (!current) return null;

      const rawSecret = base64UrlEncode(crypto.randomBytes(DEVICE_SECRET_BYTES));
      const secretHash = sha256Hex(rawSecret);

      const set: {
        secretHash: string;
        prevSecretHash?: string;
        prevSecretExpiresAt?: Date;
      } = { secretHash };
      if (current.secretHash) {
        set.prevSecretHash = current.secretHash;
        set.prevSecretExpiresAt = new Date(Date.now() + DEVICE_SECRET_GRACE_MS);
      }

      // The CAS guard. `isNull` is the exact analogue of Mongo's
      // `{ secretHash: { $exists: false } }` for a device that has never been
      // bound — Mongo used `default: undefined` there ONLY because a sparse
      // unique index collides on nulls, which Postgres does not do. Comparing
      // against `''` instead would match nothing and silently never bind a
      // first secret.
      const updated = await db
        .update(deviceSessions)
        .set(set)
        .where(
          and(
            eq(deviceSessions.deviceId, deviceId),
            current.secretHash
              ? eq(deviceSessions.secretHash, current.secretHash)
              : isNull(deviceSessions.secretHash),
          ),
        )
        .returning({ id: deviceSessions.id });
      if (updated.length > 0) return rawSecret;
    }
    return null;
  }

  /**
   * Resolve the `DeviceSessionState` bound to a raw `deviceSecret`. The secret is
   * hashed and matched — constant-time — against the device's current
   * `secret_hash` OR, within the grace window, its `prev_secret_hash`. Returns
   * null when the device is unknown, carries no secret, or the secret does not
   * match (possession of the deviceId alone reveals nothing).
   */
  async getStateBySecret(deviceId: string, rawSecret: string): Promise<DeviceSessionState | null> {
    if (typeof deviceId !== 'string' || deviceId.length === 0) return null;
    if (typeof rawSecret !== 'string' || rawSecret.length === 0) return null;

    const doc = await this.load(getDb(), deviceId);
    if (!doc) return null;

    const hash = sha256Hex(rawSecret);
    // Constant-time throughout — never `!==` on secret material.
    if (
      typeof doc.secretHash === 'string' &&
      doc.secretHash.length > 0 &&
      timingSafeStringEqual(hash, doc.secretHash)
    ) {
      return projectState(doc);
    }
    if (
      typeof doc.prevSecretHash === 'string' &&
      doc.prevSecretHash.length > 0 &&
      doc.prevSecretExpiresAt instanceof Date &&
      doc.prevSecretExpiresAt.getTime() > Date.now() &&
      timingSafeStringEqual(hash, doc.prevSecretHash)
    ) {
      return projectState(doc);
    }
    return null;
  }

  /**
   * Provision (or replace) the non-rotating background credential for ONE
   * account on a device. Bearer-gated at the route; the raw secret is returned
   * exactly once and only its hash is stored. Returns null when the device is
   * unknown or the account is not a live member of the device set.
   */
  async issueBackgroundCredential(
    deviceId: string,
    accountId: string,
  ): Promise<{ deviceId: string; secret: string; accountId: string; expiresAt: string } | null> {
    const state = await this.getState(deviceId);
    const token = await this.resolveTokenForAccount(state, accountId);
    if (!token) return null;

    const rawSecret = base64UrlEncode(crypto.randomBytes(DEVICE_SECRET_BYTES));
    const secretHash = sha256Hex(rawSecret);
    const expiresAt = new Date(Date.now() + BACKGROUND_CREDENTIAL_TTL_MS);

    const updated = await getDb()
      .update(deviceSessions)
      .set({
        backgroundSecretHash: secretHash,
        backgroundSecretAccountId: accountId,
        backgroundSecretExpiresAt: expiresAt,
      })
      .where(eq(deviceSessions.deviceId, deviceId))
      .returning({ id: deviceSessions.id });
    if (updated.length === 0) return null;

    return {
      deviceId,
      secret: rawSecret,
      accountId,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Mint a short access token from a background credential. NEVER rotates the
   * presented secret. Distinguishes an invalid/expired credential from a live
   * credential whose bound account is no longer on the device.
   */
  async mintFromBackgroundSecret(deviceId: string, rawSecret: string): Promise<BackgroundMintResult> {
    if (typeof deviceId !== 'string' || deviceId.length === 0) {
      return { ok: false, reason: 'background_credential_invalid' };
    }
    if (typeof rawSecret !== 'string' || rawSecret.length === 0) {
      return { ok: false, reason: 'background_credential_invalid' };
    }

    const doc = await this.load(getDb(), deviceId);
    if (!doc) return { ok: false, reason: 'background_credential_invalid' };

    const hash = sha256Hex(rawSecret);
    const storedHash = doc.backgroundSecretHash;
    const expiresAt = doc.backgroundSecretExpiresAt;
    const boundAccountId = doc.backgroundSecretAccountId;

    if (
      typeof storedHash !== 'string' ||
      storedHash.length === 0 ||
      !(expiresAt instanceof Date) ||
      expiresAt.getTime() <= Date.now() ||
      !boundAccountId ||
      !timingSafeStringEqual(hash, storedHash)
    ) {
      return { ok: false, reason: 'background_credential_invalid' };
    }

    const state = projectState(doc);
    const token = await this.resolveTokenForAccount(state, boundAccountId);
    if (!token) {
      return { ok: false, reason: 'account_not_on_device' };
    }

    return {
      ok: true,
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      accountId: boundAccountId,
    };
  }

  /** The background-credential triple, cleared. NULL is "absent"; `''` is a value. */
  private clearedBackgroundCredentialFields(): {
    backgroundSecretHash: null;
    backgroundSecretAccountId: null;
    backgroundSecretExpiresAt: null;
  } {
    return {
      backgroundSecretHash: null,
      backgroundSecretAccountId: null,
      backgroundSecretExpiresAt: null,
    };
  }

  /**
   * Remove a deleted account from every device session that still lists it.
   * Reuses the normal signout cascade (deactivates sessions, drops the account's
   * entry, and removes any managed accounts the user operated).
   *
   * The lookup is an indexed join on `device_session_accounts.account_id`
   * (`device_session_accounts_account_id_idx`) — under Mongo the same question
   * was a scan of every document's embedded `accounts.accountId`.
   */
  async purgeAccountFromAllDevices(userId: string): Promise<void> {
    const rows = await getDb()
      .selectDistinct({ deviceId: deviceSessions.deviceId })
      .from(deviceSessionAccounts)
      .innerJoin(deviceSessions, eq(deviceSessionAccounts.deviceSessionId, deviceSessions.id))
      .where(eq(deviceSessionAccounts.accountId, userId));
    for (const row of rows) {
      try {
        await this.signout(row.deviceId, { accountId: userId });
      } catch (error) {
        logger.warn('deviceSession.purgeAccountFromAllDevices: signout failed', {
          deviceId: row.deviceId,
          userId,
          error,
        });
      }
    }
  }
}

// Exported BOTH as the default (existing static `import deviceSessionService`
// call sites) AND as a named export so dynamic `await import(...)` consumers can
// destructure it cleanly under NodeNext CJS interop (a default-only export
// resolves to the namespace object there — same reason `account.service`
// exports `accountService` by name).
export const deviceSessionService = new DeviceSessionService();
export default deviceSessionService;
