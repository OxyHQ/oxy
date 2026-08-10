import * as crypto from 'crypto';
import { and, asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { DeviceSessionState, SessionAccount } from '@oxyhq/contracts';
import { isUniqueViolation } from '@oxyhq/db';
import { getDb, type Database } from '../config/postgres';
import { deviceAccountContexts } from '../db/schema/deviceAccountContexts';
import { devicePrincipals } from '../db/schema/devicePrincipals';
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
 * How many times a device mutation is retried when a CONCURRENT one wins the
 * race for an `authuser` slot.
 *
 * `device_principals_device_session_id_authuser_key` did not exist on the flat
 * table, so two simultaneous adds could both allocate the same "lowest free"
 * number and both succeed, leaving two people addressed by one slot. Now the
 * loser is rejected, and one failed statement aborts the WHOLE transaction in
 * Postgres (`25P02`) — so the retry has to restart the transaction, not the
 * statement. One retry is enough: the winner has committed by then, so the
 * second attempt sees its slot taken and picks the next.
 */
const AUTHUSER_RACE_ATTEMPTS = 2;

/**
 * One account signed in on one device — projected from a
 * `device_account_contexts` row and its principal.
 *
 * `operatedByUserId` is the OPERATOR of a delegated (`account:act_as`) entry and
 * `null` for an ordinary personal account. That null is load-bearing, not
 * incidental: it is the whole distinction between a delegated entry, whose
 * validity is bounded by a live `account:act_as` re-check, and a plain one that
 * carries no such check. Nothing in this module may collapse the two.
 *
 * It is now DERIVED rather than stored — a context whose principal is somebody
 * other than the account it names IS the delegated case — which is why the two
 * can no longer disagree.
 */
interface DeviceAccountRow {
  accountId: string;
  sessionId: string;
  authuser: number;
  operatedByUserId: string | null;
}

/**
 * One `principal acting as account` row, joined to its principal.
 *
 * The write paths work in these; `DeviceAccountRow` above is the flat
 * projection of them that the wire contract still speaks.
 */
interface DeviceContextRow {
  contextId: string;
  principalId: string;
  principalUserId: string;
  authuser: number;
  accountId: string;
  /** NULL means "reachable, never yet used here" — see the schema module. */
  sessionId: string | null;
}

/**
 * A device and everything signed in on it — the `device_sessions` row plus the
 * flat projection of its principals and contexts.
 *
 * `accounts` is the COMPATIBILITY view (ADR 0001): the wire contract
 * `DeviceSessionState.accounts[]` predates the principal/context split and is
 * kept working from the new tables until every supported client has moved to
 * the directory contract in ADR 0002.
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

/**
 * The lowest slot no PERSON on this device holds.
 *
 * `authuser` belongs to the principal, so an organization never consumes one —
 * on the flat table it did, which is why the number stopped naming a human
 * (ADR 0001). The allocation rule itself is unchanged: lowest free, so a slot
 * freed by a sign-out is reused rather than the counter climbing forever.
 */
function lowestFreeAuthuser(taken: readonly number[]): number {
  const used = new Set(taken);
  let i = 0;
  while (used.has(i)) i += 1;
  return i;
}

/**
 * The flat projection of a device's contexts, in the order the old
 * `device_session_accounts` read produced.
 *
 * A context with no session is OMITTED: `SessionAccount.sessionId` is a
 * required string on the wire, and a placeholder there would be a phantom
 * account the mint path would then have to defend against. Such a row is
 * "reachable, never yet used here" and belongs to the directory contract
 * (ADR 0002), not to this one.
 */
function projectAccounts(contexts: readonly DeviceContextRow[]): DeviceAccountRow[] {
  // `flatMap` rather than `filter`, because it is also what NARROWS
  // `sessionId` to `string` — a `filter` leaves it `string | null` and the only
  // ways out of that are a cast or a non-null assertion.
  return contexts.flatMap((context) =>
    context.sessionId === null
      ? []
      : [
          {
            accountId: context.accountId,
            sessionId: context.sessionId,
            authuser: context.authuser,
            // The principal acting as somebody else IS the delegated case.
            operatedByUserId:
              context.principalUserId === context.accountId ? null : context.principalUserId,
          },
        ]
  );
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
  /** The `device_sessions` row alone, without its principals or contexts. */
  private async loadDevice(db: Queryable, deviceId: string) {
    const [device] = await db
      .select({
        id: deviceSessions.id,
        deviceId: deviceSessions.deviceId,
        activeAccountId: deviceSessions.activeAccountId,
        activeContextId: deviceSessions.activeContextId,
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
    return device;
  }

  /**
   * A device's LIVE contexts, each joined to the person acting through it.
   *
   * The order is `added_at`, then the principal's `authuser`, then the context
   * id. The first two reproduce the Mongo array order this replaced (a fresh add
   * appended; a re-add rebuilt the array with a fresh `addedAt`, so both landed
   * last), and the order is not cosmetic — `signout` elects `remaining[0]` as
   * the next active account, so an unordered read would make that election
   * arbitrary. The context id is the third key because the second is no longer
   * a tiebreak on its own: a person's personal and delegated contexts share one
   * `authuser`, by design.
   *
   * A revoked principal takes its contexts with it. Filtering on `revoked_at`
   * rather than on row existence is what keeps "was Alice ever here" answerable.
   */
  private async loadContexts(
    db: Queryable,
    deviceSessionId: string
  ): Promise<DeviceContextRow[]> {
    return db
      .select({
        contextId: deviceAccountContexts.id,
        principalId: devicePrincipals.id,
        principalUserId: devicePrincipals.userId,
        authuser: devicePrincipals.authuser,
        accountId: deviceAccountContexts.accountId,
        sessionId: deviceAccountContexts.sessionId,
      })
      .from(deviceAccountContexts)
      .innerJoin(devicePrincipals, eq(deviceAccountContexts.principalId, devicePrincipals.id))
      .where(
        and(
          eq(deviceAccountContexts.deviceSessionId, deviceSessionId),
          isNull(deviceAccountContexts.revokedAt),
          isNull(devicePrincipals.revokedAt)
        )
      )
      .orderBy(
        asc(deviceAccountContexts.addedAt),
        asc(devicePrincipals.authuser),
        asc(deviceAccountContexts.id)
      );
  }

  /**
   * Read a device and the flat projection of what is signed in on it.
   *
   * Every field is named rather than spread: `active_context_id` is the new
   * authority and deliberately absent from the flat row, so spreading would
   * carry it into a shape whose whole purpose is to describe the OLD contract.
   */
  private async load(db: Queryable, deviceId: string): Promise<DeviceSessionRow | null> {
    const device = await this.loadDevice(db, deviceId);
    if (!device) return null;
    const contexts = await this.loadContexts(db, device.id);
    return {
      id: device.id,
      deviceId: device.deviceId,
      activeAccountId: device.activeAccountId,
      secretHash: device.secretHash,
      prevSecretHash: device.prevSecretHash,
      prevSecretExpiresAt: device.prevSecretExpiresAt,
      backgroundSecretHash: device.backgroundSecretHash,
      backgroundSecretAccountId: device.backgroundSecretAccountId,
      backgroundSecretExpiresAt: device.backgroundSecretExpiresAt,
      revision: device.revision,
      updatedAt: device.updatedAt,
      accounts: projectAccounts(contexts),
    };
  }

  /**
   * Find or create the principal for `userId` on this device, and return its id.
   *
   * `ON CONFLICT … DO UPDATE … RETURNING`, never read-then-write: in Postgres one
   * failed statement aborts the WHOLE transaction (`25P02`), so Mongo's
   * read-the-row-back-after-a-duplicate-key recovery does not port. The insert
   * is the read.
   *
   * A revoked principal signing back in is un-revoked rather than duplicated —
   * `UNIQUE(device_session_id, user_id)` means there is only ever one row per
   * person per device to bring back.
   */
  private async ensurePrincipal(
    tx: Queryable,
    deviceSessionId: string,
    userId: string,
    /** The person's OWN session, set only by a personal registration. */
    personalSessionId: string | null
  ): Promise<string> {
    const taken = await tx
      .select({ authuser: devicePrincipals.authuser })
      .from(devicePrincipals)
      .where(eq(devicePrincipals.deviceSessionId, deviceSessionId));

    const now = new Date();
    const [row] = await tx
      .insert(devicePrincipals)
      .values({
        deviceSessionId,
        userId,
        authuser: lowestFreeAuthuser(taken.map((entry) => entry.authuser)),
        personalSessionId,
        lastAuthenticatedAt: now,
      })
      .onConflictDoUpdate({
        target: [devicePrincipals.deviceSessionId, devicePrincipals.userId],
        set: {
          lastAuthenticatedAt: now,
          revokedAt: null,
          // A DELEGATED add must not clear the person's own session: they are
          // still signed in as themselves, they are merely also acting as
          // something else.
          ...(personalSessionId === null ? {} : { personalSessionId }),
        },
      })
      .returning({ id: devicePrincipals.id });
    return row.id;
  }

  /**
   * Delete every principal of this device that has no live context left.
   *
   * A person with nothing to act as here is not on this device — which is
   * exactly what removing their last `device_session_accounts` row used to mean,
   * and what keeps their `authuser` slot available to the next sign-in.
   */
  private async pruneOrphanPrincipals(tx: Queryable, deviceSessionId: string): Promise<void> {
    const live = await tx
      .selectDistinct({ principalId: deviceAccountContexts.principalId })
      .from(deviceAccountContexts)
      .where(
        and(
          eq(deviceAccountContexts.deviceSessionId, deviceSessionId),
          isNull(deviceAccountContexts.revokedAt)
        )
      );
    const keep = live.map((entry) => entry.principalId);
    await tx
      .delete(devicePrincipals)
      .where(
        keep.length === 0
          ? eq(devicePrincipals.deviceSessionId, deviceSessionId)
          : and(
              eq(devicePrincipals.deviceSessionId, deviceSessionId),
              notInArray(devicePrincipals.id, keep)
            )
      );
  }

  /**
   * The `active_*` pair for a device that should be pointing at `accountId`.
   *
   * `active_context_id` is the authority (ADR 0002) and `active_account_id` is
   * DERIVED from the elected context — computed HERE and at no other site, which
   * is what stops the two columns from disagreeing while the flat contract still
   * has consumers.
   *
   * An account with no live context resolves to `(null, null)`: NULL is the
   * first-class "signed in, nothing selected" state, and leaving the device
   * naming an account it cannot mint for is the durable "logged in as <org>"
   * lie `healActiveAccount` exists to clear up.
   */
  private async resolveActiveFields(
    tx: Queryable,
    deviceSessionId: string,
    accountId: string | null
  ): Promise<{ activeContextId: string | null; activeAccountId: string | null }> {
    if (accountId === null) return { activeContextId: null, activeAccountId: null };
    const contexts = await this.loadContexts(tx, deviceSessionId);
    const elected = contexts.find((context) => context.accountId === accountId);
    if (!elected) return { activeContextId: null, activeAccountId: null };
    return { activeContextId: elected.contextId, activeAccountId: accountId };
  }

  /**
   * Run one device mutation, retrying once if a CONCURRENT one took the
   * `authuser` slot this attempt allocated.
   *
   * Only that one constraint is answered for. `isUniqueViolation(error)` alone
   * cannot tell "the slot was taken" from "some other unique fired", and mapping
   * every duplicate onto a retry would quietly start re-running writes for
   * reasons nobody chose.
   */
  private async withAuthuserRaceRetry<T>(run: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < AUTHUSER_RACE_ATTEMPTS; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        if (!isUniqueViolation(error, 'device_principals_device_session_id_authuser_key')) {
          throw error;
        }
        lastError = error;
      }
    }
    throw lastError;
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

    const result = await this.withAuthuserRaceRetry(async () => {
      displacedSessionId = null;
      return getDb().transaction(async (tx) => {
        const current = await this.ensureDevice(tx, deviceId);
        const contexts = await this.loadContexts(tx, current.id);
        // Keyed on the ACCOUNT, not on the pair, which keeps this path
        // producing the one-entry-per-account set the flat contract promises.
        // The schema can now hold `Nate -> Org` beside `Alice -> Org`; reaching
        // that state is `POST /session/device/activate`'s job (ADR 0002), not
        // this compatibility path's.
        const existing = contexts.find((c) => c.accountId === input.accountId);

        // Case 1 — idempotent re-register (the cold-boot reload handoff).
        if (existing && existing.sessionId === input.sessionId) {
          const state = projectState(current);
          return { state, changed: false };
        }

        // Case 2 — replacing an account's session (re-add with a new sessionId)
        // must deactivate the session it displaces — otherwise a live,
        // server-side session is left dangling with no context referencing it.
        // A context with no session displaces nothing: there is no session to
        // kill, only a "reachable, never used" row to fill in.
        if (existing) {
          displacedSessionId = existing.sessionId;
          await tx
            .delete(deviceAccountContexts)
            .where(eq(deviceAccountContexts.id, existing.contextId));
        }

        const principalUserId = input.operatedByUserId ?? input.accountId;
        const principalId = await this.ensurePrincipal(
          tx,
          current.id,
          principalUserId,
          // NULL, never a placeholder: a delegated add is exactly the one where
          // the person is not the account, and `''` would read as a personal
          // session belonging to nobody.
          principalUserId === input.accountId ? input.sessionId : null
        );

        await tx
          .insert(deviceAccountContexts)
          .values({
            deviceSessionId: current.id,
            principalId,
            accountId: input.accountId,
            sessionId: input.sessionId,
          })
          // The pair may already exist as a revoked row, or as one this same
          // request lost a race to. `DO UPDATE` resolves both without a
          // read-then-write, which Postgres cannot recover from inside a
          // transaction (a failed statement aborts all of it, 25P02).
          // `added_at` moves because a re-add replaces the entry wholesale,
          // which is what the flat path did too — and the read order depends
          // on it.
          .onConflictDoUpdate({
            target: [
              deviceAccountContexts.deviceSessionId,
              deviceAccountContexts.principalId,
              deviceAccountContexts.accountId,
            ],
            set: { sessionId: input.sessionId, revokedAt: null, addedAt: new Date() },
          });

        // Every principal keeps at least one context here, so nothing is
        // orphaned by the delete above — except when case 2 moved an account to
        // a DIFFERENT operator, which leaves the previous one with nothing.
        await this.pruneOrphanPrincipals(tx, current.id);

        // 'if-empty' preserves an existing active account; only claims active
        // when the device currently has none. The re-election still has to run
        // in that branch: case 2 replaced the active account's context row, so
        // `active_context_id` was nulled by its own foreign key.
        const nextActiveAccountId =
          activate === 'always' || !current.activeAccountId
            ? input.accountId
            : current.activeAccountId;

        await tx
          .update(deviceSessions)
          .set({
            ...(await this.resolveActiveFields(tx, current.id, nextActiveAccountId)),
            revision: sql`${deviceSessions.revision} + 1`,
          })
          .where(eq(deviceSessions.id, current.id));

        const updated = await this.load(tx, deviceId);
        if (!updated) {
          throw new Error(`device_sessions row for "${deviceId}" vanished during addAccount`);
        }
        return { state: projectState(updated), changed: true };
      });
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
        .set({
          ...(await this.resolveActiveFields(tx, current.id, accountId)),
          revision: sql`${deviceSessions.revision} + 1`,
        })
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
      // is ADR 0001's "removing a principal removes exactly its own contexts",
      // and it is the same rule `device_account_contexts.principal_id`'s
      // ON DELETE CASCADE enforces for a delete that never reaches this service.
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
        // Scoped by ACCOUNT, so it removes that account under every principal
        // of this device. Under this path there is only ever one — the flat
        // contract's own promise — and Phase 2's context-scoped removal is what
        // ADR 0001's "remove ONE context" means once a device can hold the same
        // account under two people.
        await tx
          .delete(deviceAccountContexts)
          .where(
            and(
              eq(deviceAccountContexts.deviceSessionId, current.id),
              inArray(deviceAccountContexts.accountId, [...removingIds]),
            ),
          );
        // The person whose last context just went is no longer on this device,
        // and their `authuser` slot returns to the pool.
        await this.pruneOrphanPrincipals(tx, current.id);
      }
      await tx
        .update(deviceSessions)
        .set({
          ...(await this.resolveActiveFields(tx, current.id, nextActive)),
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
        .delete(deviceAccountContexts)
        .where(
          and(
            eq(deviceAccountContexts.deviceSessionId, current.id),
            eq(deviceAccountContexts.accountId, accountId),
          ),
        );
      await this.pruneOrphanPrincipals(tx, current.id);
      await tx
        .update(deviceSessions)
        .set({
          ...(await this.resolveActiveFields(tx, current.id, nextActive)),
          revision: sql`${deviceSessions.revision} + 1`,
        })
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
   * The lookup is an indexed join on `device_account_contexts.account_id`
   * (`device_account_contexts_account_id_idx`) — under Mongo the same question
   * was a scan of every document's embedded `accounts.accountId`.
   */
  async purgeAccountFromAllDevices(userId: string): Promise<void> {
    const rows = await getDb()
      .selectDistinct({ deviceId: deviceSessions.deviceId })
      .from(deviceAccountContexts)
      .innerJoin(deviceSessions, eq(deviceAccountContexts.deviceSessionId, deviceSessions.id))
      .where(eq(deviceAccountContexts.accountId, userId));
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
