import * as crypto from 'crypto';
import type { Request } from 'express';
import { and, asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type {
  AccountKind,
  DeviceAccountContext,
  DeviceContextRelationship,
  DeviceDirectory,
  DeviceDirectoryProfile,
  DevicePrincipal,
  DeviceSessionState,
  SessionAccount,
} from '@oxyhq/contracts';
import { deviceDirectorySchema, isActAsEligibleKind } from '@oxyhq/contracts';
import { isUniqueViolation } from '@oxyhq/db';
import { getDb, type Database } from '../config/postgres';
import { deviceAccountContexts } from '../db/schema/deviceAccountContexts';
import { devicePrincipals } from '../db/schema/devicePrincipals';
import { deviceSessions } from '../db/schema/deviceSessions';
import { sessions } from '../db/schema/sessions';
import { users } from '../db/schema/users';
import sessionCache from '../utils/sessionCache';
import sessionService from './session.service';
import { sha256Hex, base64UrlEncode, timingSafeStringEqual } from './oauthCode.service';
import { effectivePermissionsForMember } from '../utils/accountRoles';
import { formatUserNameResponse } from '../utils/displayName';
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
  lastUsedAt: Date | null;
}

/** A PERSON on a device — the `device_principals` row the directory reports. */
interface DevicePrincipalRow {
  id: string;
  userId: string;
  authuser: number;
  /** The session minted when this person authenticated here. */
  personalSessionId: string | null;
}

/**
 * An account one principal may act as RIGHT NOW, with the display metadata the
 * directory renders it with.
 *
 * Built from the live account graph, never from the device's own rows: the
 * question "may this person act as this account" is an authorization question
 * whose answer changes without anything on the device changing (ADR 0002).
 */
interface ActAsAccount {
  accountId: string;
  kind: AccountKind;
  relationship: DeviceContextRelationship;
  profile: DeviceDirectoryProfile;
}

/** A context is PERSONAL when the person and the subject are the same account. */
function isPersonalContext(context: Pick<DeviceContextRow, 'principalUserId' | 'accountId'>): boolean {
  return context.principalUserId === context.accountId;
}

/**
 * The minimum that renders a switcher row, and nothing more.
 *
 * Deliberately not `formatUserResponse`: the directory is read by every app on
 * the device, and a general profile serializer there would quietly turn an
 * account switcher into a profile feed for accounts the caller may never have
 * asked about.
 */
function directoryProfile(row: {
  id: string;
  username: string | null;
  nameFirst: string | null;
  nameLast: string | null;
  nameDisplay: string | null;
  avatar: string | null;
  color: string | null;
}): DeviceDirectoryProfile {
  const name = formatUserNameResponse({
    name: { first: row.nameFirst, last: row.nameLast, displayName: row.nameDisplay },
    username: row.username,
  });
  const profile: DeviceDirectoryProfile = {
    id: row.id,
    username: row.username ?? '',
    avatar: row.avatar ?? null,
    // The accent the row is DRAWN in, not profile data: without it every
    // non-active row falls back to the ambient theme accent (issue #961).
    color: row.color ?? null,
  };
  // `name.displayName` stays OPTIONAL and the whole object is omitted when the
  // account has no real name at all — consumers fall back to the handle, never
  // to a synthesized name.
  if (Object.keys(name).length > 0) profile.name = name;
  return profile;
}

/**
 * Which context becomes active when the active one is removed.
 *
 * The order is the one `docs/auth/principals-and-account-contexts.md` states for
 * sign-out meaning 2 ("remove one context"): the same person's own account
 * first, then anything else that person reaches, then the NEXT person's own
 * account, then nothing. It is deliberately biased towards keeping the device on
 * the SAME human — a removal should never silently hand the device to somebody
 * else while another of the departing person's contexts is still available.
 *
 * Pure, and exported for its own unit test: the election is the one part of
 * removal whose wrongness is invisible in a passing integration test, because
 * every candidate order produces *an* active context.
 */
export function electReplacementContext(
  remaining: readonly DeviceContextRow[],
  principals: readonly Pick<DevicePrincipalRow, 'id' | 'authuser'>[],
  removedPrincipalId: string | null
): DeviceContextRow | null {
  const byAccount = (a: DeviceContextRow, b: DeviceContextRow) =>
    a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0;

  if (removedPrincipalId !== null) {
    const own = remaining.filter((context) => context.principalId === removedPrincipalId);
    const personal = own.find(isPersonalContext);
    if (personal) return personal;
    const other = [...own].sort(byAccount);
    if (other.length > 0) return other[0];
  }

  const others = principals
    .filter((principal) => principal.id !== removedPrincipalId)
    .sort((a, b) => a.authuser - b.authuser);
  for (const principal of others) {
    const personal = remaining.find(
      (context) => context.principalId === principal.id && isPersonalContext(context)
    );
    if (personal) return personal;
  }
  return null;
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

/**
 * The outcome of `POST /session/device/activate`.
 *
 * `changed: false` is the IDEMPOTENT activation — the target was already the
 * active context and already bound to the same live session, so nothing was
 * written, `revision` did not move and the route must not broadcast (ADR 0002).
 * It is a success, and the caller still gets the directory and a bearer.
 *
 * `unauthorized` carries the HEALED state: a stale or revoked target is removed
 * from the device rather than left to be selected again, so the route has
 * something to broadcast even though the activation failed.
 */
export type ActivateContextResult =
  | {
      ok: true;
      changed: boolean;
      accountId: string;
      directory: DeviceDirectory;
      state: DeviceSessionState;
      activeToken: { accessToken: string; expiresAt: string } | null;
    }
  | { ok: false; reason: 'not_found' }
  | {
      ok: false;
      reason: 'unauthorized';
      accountId: string;
      directory: DeviceDirectory;
      state: DeviceSessionState;
    };

/** The outcome of removing one context or one principal from a device. */
export type RemoveFromDeviceResult =
  | { ok: true; directory: DeviceDirectory; state: DeviceSessionState; removedAccountIds: string[] }
  | { ok: false; reason: 'not_found' };

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
        lastUsedAt: deviceAccountContexts.lastUsedAt,
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
    if (accountId === null) return this.activeFieldsFor(null);
    const contexts = await this.loadContexts(tx, deviceSessionId);
    const elected = contexts.find((context) => context.accountId === accountId);
    return this.activeFieldsFor(elected ?? null);
  }

  /**
   * The `active_*` pair for an already-elected context — the ONE place either
   * column's value is composed. `resolveActiveFields` above is the flat
   * contract's entry point into it (elect by account, then compose here).
   */
  private activeFieldsFor(
    context: Pick<DeviceContextRow, 'contextId' | 'accountId'> | null
  ): { activeContextId: string | null; activeAccountId: string | null } {
    if (context === null) return { activeContextId: null, activeAccountId: null };
    return { activeContextId: context.contextId, activeAccountId: context.accountId };
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
    await this.ensureDeviceRecord(db, deviceId);
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

  /**
   * The RAW `device_sessions` row, created empty if absent.
   *
   * Distinct from {@link DeviceSessionService.ensureDevice} because the flat row
   * that one returns deliberately drops `active_context_id` — the directory is
   * the contract that reports it, so it needs the row itself.
   */
  private async ensureDeviceRecord(db: Queryable, deviceId: string) {
    await db
      .insert(deviceSessions)
      .values({ deviceId })
      .onConflictDoNothing({ target: deviceSessions.deviceId });
    const row = await this.loadDevice(db, deviceId);
    if (!row) {
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
    return this.resolveTokenForSession(account.sessionId);
  }

  /**
   * The access token of ONE session, or null when it is no longer live.
   *
   * Re-validates before minting: for a managed-account session this re-checks
   * the operator's `account:act_as` membership (`ensureManagedSessionAuthorized`)
   * and deactivates+rejects a revoked session instead of handing out a token for
   * an account the caller no longer has authority over.
   */
  private async resolveTokenForSession(
    sessionId: string
  ): Promise<{ accessToken: string; expiresAt: string } | null> {
    const validated = await sessionService.validateSessionById(sessionId, false);
    if (!validated) return null;
    const token = await sessionService.getAccessToken(sessionId);
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

  // =========================================================================
  // The directory read model and the one activation write (ADR 0002)
  // =========================================================================

  /** The PEOPLE on a device, in `authuser` order. Revoked principals excluded. */
  private async loadPrincipals(
    db: Queryable,
    deviceSessionId: string
  ): Promise<DevicePrincipalRow[]> {
    return db
      .select({
        id: devicePrincipals.id,
        userId: devicePrincipals.userId,
        authuser: devicePrincipals.authuser,
        personalSessionId: devicePrincipals.personalSessionId,
      })
      .from(devicePrincipals)
      .where(
        and(
          eq(devicePrincipals.deviceSessionId, deviceSessionId),
          isNull(devicePrincipals.revokedAt)
        )
      )
      .orderBy(asc(devicePrincipals.authuser), asc(devicePrincipals.id));
  }

  /**
   * Every account one PERSON may act as right now, keyed by account id.
   *
   * `account.service` is imported LAZILY for the same reason `session.service`
   * does it: a static edge would pull the whole account graph into the module
   * graph of every consumer of the device session, including the mint path,
   * which needs none of it.
   *
   * A CHANNEL is never here — it is a content identity, not a seat anybody
   * occupies (`isActAsEligibleKind`), so it can never be a switcher row. The
   * permission is read off the resolved membership rather than off the role,
   * exactly as `verifyActingAs` does, so a per-member revoke of
   * `account:act_as` removes the row here too instead of the directory offering
   * a switch the activation endpoint would then refuse.
   */
  private async loadActAsAccounts(userId: string): Promise<Map<string, ActAsAccount>> {
    const { accountService } = await import('./account.service.js');
    const nodes = await accountService.listAccessibleAccounts(userId);
    const reachable = new Map<string, ActAsAccount>();
    for (const node of nodes) {
      const actable =
        node.relationship === 'self' ||
        (isActAsEligibleKind(node.kind) &&
          node.callerMembership !== null &&
          effectivePermissionsForMember(node.callerMembership).includes('account:act_as'));
      if (!actable) continue;
      reachable.set(node.accountId, {
        accountId: node.accountId,
        kind: node.kind,
        relationship: node.relationship,
        profile: directoryProfile(node.account),
      });
    }
    return reachable;
  }

  /** The act-as set of every principal on the device, keyed by principal id. */
  private async loadActAsByPrincipal(
    principals: readonly DevicePrincipalRow[]
  ): Promise<Map<string, Map<string, ActAsAccount>>> {
    const byPrincipal = new Map<string, Map<string, ActAsAccount>>();
    for (const principal of principals) {
      byPrincipal.set(principal.id, await this.loadActAsAccounts(principal.userId));
    }
    return byPrincipal;
  }

  /**
   * Display metadata for accounts the live graph no longer reaches.
   *
   * A context whose `account:act_as` was revoked is still REPORTED — with
   * `available: false` — so the UI can explain a row going away instead of
   * dropping it silently (ADR 0002). Its profile therefore has to come from
   * somewhere other than the act-as set it just fell out of.
   */
  private async loadProfilesByAccountId(
    db: Queryable,
    accountIds: readonly string[]
  ): Promise<Map<string, { profile: DeviceDirectoryProfile; kind: AccountKind }>> {
    const byId = new Map<string, { profile: DeviceDirectoryProfile; kind: AccountKind }>();
    if (accountIds.length === 0) return byId;
    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        nameFirst: users.nameFirst,
        nameLast: users.nameLast,
        nameDisplay: users.nameDisplay,
        avatar: users.avatar,
        color: users.color,
        kind: users.kind,
      })
      .from(users)
      .where(inArray(users.id, [...accountIds]));
    for (const row of rows) {
      byId.set(row.id, { profile: directoryProfile(row), kind: row.kind });
    }
    return byId;
  }

  /**
   * Bring the device's context rows in line with the live account graph.
   *
   * A row exists for every account a principal may act as, because `contextId`
   * is what activation takes and an id has to be stable before it can be sent
   * (the schema module states the same invariant). The DELEGATED SESSION is what
   * is minted lazily — not the row — so this materializes `session_id IS NULL`
   * rows and nothing else.
   *
   * It also drops a NEVER-USED row whose account has fallen out of the act-as
   * set. A row that HAS been used stays, and is reported `available: false`: the
   * difference is whether the user has ever seen it, and dropping something they
   * have never seen explains nothing while letting the table grow with every
   * membership a person has ever briefly held.
   *
   * `revision` is deliberately NOT bumped. It tracks what this DEVICE holds —
   * principals, sessions, the active context — and a reachable-but-unused row is
   * a projection of a graph that changes for reasons having nothing to do with
   * this device. Bumping here would advance a revision on a READ, which is the
   * one thing `revision` promises never to do.
   */
  private async reconcileContexts(
    db: Queryable,
    deviceSessionId: string,
    principals: readonly DevicePrincipalRow[],
    contexts: readonly DeviceContextRow[],
    actAsByPrincipal: ReadonlyMap<string, ReadonlyMap<string, ActAsAccount>>
  ): Promise<boolean> {
    const missing: { principalId: string; accountId: string }[] = [];
    const staleContextIds: string[] = [];

    for (const principal of principals) {
      const actAs = actAsByPrincipal.get(principal.id);
      if (!actAs) continue;
      const own = contexts.filter((context) => context.principalId === principal.id);
      const held = new Set(own.map((context) => context.accountId));
      // Sorted so a device that gains three organizations at once materializes
      // them in one order, not in whatever order the graph query returned.
      for (const accountId of [...actAs.keys()].sort()) {
        if (!held.has(accountId)) missing.push({ principalId: principal.id, accountId });
      }
      for (const context of own) {
        if (context.sessionId === null && !actAs.has(context.accountId)) {
          staleContextIds.push(context.contextId);
        }
      }
    }

    if (missing.length === 0 && staleContextIds.length === 0) return false;

    await db.transaction(async (tx) => {
      if (missing.length > 0) {
        await tx
          .insert(deviceAccountContexts)
          .values(
            missing.map((entry) => ({
              deviceSessionId,
              principalId: entry.principalId,
              accountId: entry.accountId,
              sessionId: null,
            }))
          )
          // A concurrent directory read materializing the same pair is the
          // normal case (two apps cold-booting at once), and it must not fail
          // either of them. `DO NOTHING` on the pair's own unique, never a
          // read-then-write: one failed statement aborts the WHOLE transaction
          // in Postgres, so there would be nothing left to recover into.
          .onConflictDoNothing({
            target: [
              deviceAccountContexts.deviceSessionId,
              deviceAccountContexts.principalId,
              deviceAccountContexts.accountId,
            ],
          });
      }
      if (staleContextIds.length > 0) {
        await tx
          .delete(deviceAccountContexts)
          .where(inArray(deviceAccountContexts.id, staleContextIds));
      }
    });
    return true;
  }

  /**
   * Whether a principal is PRESENT on this device as themselves.
   *
   * ADR 0002 makes this activation step 3, and it gates every context of the
   * person — including the delegated ones. Acting as an organization is
   * something a signed-in human does; once the human's own session is gone, the
   * device has no live proof of who is doing it, and continuing to hand out
   * organization bearers on that basis is exactly the delegated fail-open this
   * phase exists to close.
   */
  private async isPrincipalLive(principal: DevicePrincipalRow): Promise<boolean> {
    if (principal.personalSessionId === null) return false;
    return (await sessionService.validateSessionById(principal.personalSessionId, false)) !== null;
  }

  /** The wire directory, built from rows already read. Validated before it ships. */
  private async buildDirectory(
    device: { deviceId: string; activeContextId: string | null; revision: number; updatedAt: Date },
    principals: readonly DevicePrincipalRow[],
    contexts: readonly DeviceContextRow[],
    actAsByPrincipal: ReadonlyMap<string, ReadonlyMap<string, ActAsAccount>>,
    fallbackProfiles: ReadonlyMap<string, { profile: DeviceDirectoryProfile; kind: AccountKind }>
  ): Promise<DeviceDirectory> {
    const liveByPrincipalId = new Map<string, boolean>();
    for (const principal of principals) {
      liveByPrincipalId.set(principal.id, await this.isPrincipalLive(principal));
    }

    const contextExists = new Set(contexts.map((context) => context.contextId));
    const wirePrincipals: DevicePrincipal[] = [];

    for (const principal of principals) {
      const actAs = actAsByPrincipal.get(principal.id);
      const principalLive = liveByPrincipalId.get(principal.id) === true;
      const own = contexts.filter((context) => context.principalId === principal.id);

      const wireContexts = own
        .map((context): DeviceAccountContext => {
          const personal = isPersonalContext(context);
          const reachable = actAs?.get(context.accountId);
          const fallback = fallbackProfiles.get(context.accountId);
          return {
            id: context.contextId,
            accountId: context.accountId,
            // A revoked membership leaves no record of whether the person was
            // an owner or an ordinary member, and `member` is the weaker of the
            // two claims — so that is the one made when the graph can no longer
            // say.
            kind: reachable?.kind ?? fallback?.kind ?? 'personal',
            relationship: reachable?.relationship ?? (personal ? 'self' : 'member'),
            account:
              reachable?.profile ??
              fallback?.profile ?? { id: context.accountId, username: '', avatar: null },
            onDevice: context.sessionId !== null,
            // Personal contexts are available while their principal is; a
            // delegated one additionally needs a LIVE `account:act_as`.
            available: principalLive && (personal || reachable !== undefined),
            active: context.contextId === device.activeContextId,
            lastUsedAt: context.lastUsedAt === null ? null : context.lastUsedAt.getTime(),
          };
        })
        // Personal first, then by account id: a total order that does not depend
        // on when a row happened to be materialized, so two reads of an
        // unchanged device are byte-identical.
        .sort((a, b) => {
          const personalA = a.accountId === principal.userId ? 0 : 1;
          const personalB = b.accountId === principal.userId ? 0 : 1;
          if (personalA !== personalB) return personalA - personalB;
          return a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0;
        });

      const selfProfile =
        actAs?.get(principal.userId)?.profile ??
        fallbackProfiles.get(principal.userId)?.profile ?? {
          id: principal.userId,
          username: '',
          avatar: null,
        };

      wirePrincipals.push({
        id: principal.id,
        userId: principal.userId,
        authuser: principal.authuser,
        user: selfProfile,
        contexts: wireContexts,
      });
    }

    const dto: DeviceDirectory = {
      deviceId: device.deviceId,
      revision: device.revision,
      // Null is a real state, not an error: every context removed, or an active
      // context healed away.
      activeContextId:
        device.activeContextId !== null && contextExists.has(device.activeContextId)
          ? device.activeContextId
          : null,
      principals: wirePrincipals,
      updatedAt: device.updatedAt.getTime(),
    };
    // Compile-time guard above (a missing or undeclared field fails `tsc` and
    // names it), runtime guard here.
    return deviceDirectorySchema.parse(dto);
  }

  /**
   * `GET /session/device/directory` — the ONE server-authoritative read model an
   * account switcher renders (ADR 0002).
   *
   * The client never reconstructs a principal's graph, because on a device
   * holding more than one person it cannot: it holds ONE caller's account graph
   * and has no way to enumerate what the OTHER principals may act as.
   */
  async getDirectory(deviceId: string): Promise<DeviceDirectory> {
    const db = getDb();
    const device = await this.ensureDeviceRecord(db, deviceId);
    const principals = await this.loadPrincipals(db, device.id);
    const actAsByPrincipal = await this.loadActAsByPrincipal(principals);
    const initial = await this.loadContexts(db, device.id);
    const reconciled = await this.reconcileContexts(
      db,
      device.id,
      principals,
      initial,
      actAsByPrincipal
    );
    const contexts = reconciled ? await this.loadContexts(db, device.id) : initial;

    const unreachable = contexts
      .map((context) => context.accountId)
      .concat(principals.map((principal) => principal.userId))
      .filter((accountId) => {
        for (const actAs of actAsByPrincipal.values()) {
          if (actAs.has(accountId)) return false;
        }
        return true;
      });
    const fallbackProfiles = await this.loadProfilesByAccountId(db, [...new Set(unreachable)]);

    // Re-read the device row only when reconciliation may have nulled
    // `active_context_id` through the foreign key.
    const finalDevice = reconciled ? await this.loadDevice(db, deviceId) : device;
    if (!finalDevice) {
      throw new Error(`device_sessions row for "${deviceId}" vanished during getDirectory`);
    }
    return this.buildDirectory(
      finalDevice,
      principals,
      contexts,
      actAsByPrincipal,
      fallbackProfiles
    );
  }

  /**
   * `POST /session/device/activate` — the ONE write, as ADR 0002 step-lists it.
   *
   * ## Why the whole transition sits inside one locked transaction
   *
   * "Concurrent activations produce one deterministic winning revision" is a
   * property of the SERIALIZATION, not of the individual statements. Resolving
   * the session outside the lock loses it in the worst way: two callers both
   * find `session_id IS NULL`, both mint (nothing in `sessions` forbids two rows
   * for one account on one device), and both then write a different session and
   * bump — one real activation, two revisions, one orphaned session. Taking the
   * device row `FOR UPDATE` first means the second caller reads the first
   * caller's committed binding, reuses it, and writes nothing.
   *
   * The session-service calls inside the transaction run on the POOL, so they
   * neither see nor participate in it. That is correct here — they read and
   * write `sessions` and `account_members`, which this transaction never
   * touches — and it is the reason the lock has to be the device row rather than
   * an optimistic revision compare.
   */
  async activateContext(
    deviceId: string,
    contextId: string,
    req: Request
  ): Promise<ActivateContextResult> {
    const db = getDb();
    const device = await this.loadDevice(db, deviceId);
    if (!device) return { ok: false, reason: 'not_found' };

    /** Deactivated AFTER the transaction commits — see `addAccount`. */
    let strandedSessionId: string | null = null;

    const outcome = await db.transaction(async (tx) => {
      // The serialization point. Everything below reads state that only this
      // transaction may then change.
      const [locked] = await tx
        .select({
          id: deviceSessions.id,
          deviceId: deviceSessions.deviceId,
          activeContextId: deviceSessions.activeContextId,
          revision: deviceSessions.revision,
          updatedAt: deviceSessions.updatedAt,
        })
        .from(deviceSessions)
        .where(eq(deviceSessions.id, device.id))
        .for('update');
      if (!locked) return { kind: 'not_found' as const };

      const contexts = await this.loadContexts(tx, locked.id);
      const target = contexts.find((context) => context.contextId === contextId);
      if (!target) return { kind: 'not_found' as const };

      const principals = await this.loadPrincipals(tx, locked.id);
      const principal = principals.find((entry) => entry.id === target.principalId);
      if (!principal) return { kind: 'not_found' as const };

      const personal = isPersonalContext(target);
      const authorized =
        (await this.isPrincipalLive(principal)) &&
        (personal || (await this.verifyDelegation(principal.userId, target.accountId)));

      if (!authorized) {
        // Fail CLOSED, and heal: leaving the row would offer the same dead
        // choice again on the very next render.
        strandedSessionId = target.sessionId;
        await this.removeContextRows(tx, locked, contexts, principals, [target]);
        return { kind: 'unauthorized' as const, accountId: target.accountId };
      }

      // Reuse or mint. A personal context is never minted here — a personal
      // session is proof that a human authenticated, and this endpoint has no
      // such proof to offer.
      let sessionId: string;
      if (personal) {
        sessionId = principal.personalSessionId ?? '';
        if (sessionId.length === 0) return { kind: 'not_found' as const };
      } else if (target.sessionId !== null && (await this.isSessionLive(target.sessionId))) {
        sessionId = target.sessionId;
      } else {
        // NO `deviceContext` here, deliberately, even though both ids are in
        // hand. This call runs on the POOL, outside the transaction — which is
        // only safe while the rows it writes are ones the transaction never
        // touches (see this method's docblock). Writing
        // `sessions.device_session_id` would take a FK KEY-SHARE lock on the
        // very `device_sessions` row locked `FOR UPDATE` above: the pool
        // connection waits for the transaction, the transaction waits for this
        // call to return, and nothing breaks the cycle because only one half of
        // it is a lock Postgres can see. The binding is written after COMMIT
        // instead (issue #937, Phase 6).
        const minted = await sessionService.createSession(target.accountId, req, {
          operatedByUserId: principal.userId,
          deviceId: locked.deviceId,
        });
        sessionId = minted.sessionId;
      }

      if (locked.activeContextId === contextId && target.sessionId === sessionId) {
        // Idempotent activation: nothing written, `revision` unmoved, and the
        // route must not broadcast.
        return { kind: 'unchanged' as const, accountId: target.accountId, sessionId };
      }

      await tx
        .update(deviceAccountContexts)
        .set({ sessionId, lastUsedAt: new Date() })
        .where(eq(deviceAccountContexts.id, contextId));
      await tx
        .update(deviceSessions)
        .set({
          ...this.activeFieldsFor(target),
          revision: sql`${deviceSessions.revision} + 1`,
        })
        .where(eq(deviceSessions.id, locked.id));
      return { kind: 'activated' as const, accountId: target.accountId, sessionId };
    });

    if (strandedSessionId) {
      try {
        await sessionService.deactivateSession(strandedSessionId);
      } catch (error) {
        logger.warn('deviceSession.activateContext: deactivate healed session failed', {
          sessionId: strandedSessionId,
          error,
        });
      }
    }

    if (outcome.kind === 'not_found') return { ok: false, reason: 'not_found' };

    const directory = await this.getDirectory(deviceId);
    const state = await this.readState(deviceId);
    if (outcome.kind === 'unauthorized') {
      return { ok: false, reason: 'unauthorized', accountId: outcome.accountId, directory, state };
    }
    // Post-COMMIT, so the FK write cannot contend with the lock the transaction
    // held. Only on a real activation: an idempotent one changed no binding, and
    // writing the same values back would invalidate the session cache for
    // nothing. `resolveTokenForSession` below then re-mints, because the stored
    // token no longer matches the row it now points at.
    if (outcome.kind === 'activated') {
      await this.bindSessionToContext(deviceId, outcome.sessionId);
    }
    return {
      ok: true,
      changed: outcome.kind === 'activated',
      accountId: outcome.accountId,
      directory,
      state,
      activeToken: await this.resolveTokenForSession(outcome.sessionId),
    };
  }

  /**
   * The flat state of a device WITHOUT the self-heal pass `getState` runs.
   *
   * The heal is a mutation, and running one immediately after a deliberate
   * transition would let it bump `revision` a second time — so the state the
   * caller broadcasts would no longer be the state the directory beside it
   * describes.
   */
  private async readState(deviceId: string): Promise<DeviceSessionState> {
    const row = await this.load(getDb(), deviceId);
    if (!row) {
      throw new Error(`device_sessions row for "${deviceId}" vanished during readState`);
    }
    return projectState(row);
  }

  /** Whether a session is still live, without loading its user. */
  private async isSessionLive(sessionId: string): Promise<boolean> {
    return (await sessionService.validateSessionById(sessionId, false)) !== null;
  }

  /** The LIVE `account:act_as` verdict for one delegated pair. */
  private async verifyDelegation(operatorId: string, accountId: string): Promise<boolean> {
    const { accountService } = await import('./account.service.js');
    return (await accountService.verifyActingAs(operatorId, accountId)) !== null;
  }

  /**
   * Delete contexts from a device inside an open transaction, re-electing the
   * active one when it was among them.
   *
   * The election order is `electReplacementContext`'s, which is the documented
   * one for sign-out meanings 2 and 3. The FLAT `signout` path keeps its own
   * (first remaining, in read order) — it removes an ACCOUNT across principals
   * rather than a pair, so "the same principal's other contexts" is not a
   * question it can ask.
   */
  private async removeContextRows(
    tx: Queryable,
    device: { id: string; activeContextId: string | null },
    contexts: readonly DeviceContextRow[],
    principals: readonly DevicePrincipalRow[],
    victims: readonly DeviceContextRow[]
  ): Promise<void> {
    if (victims.length === 0) return;
    const victimIds = new Set(victims.map((context) => context.contextId));
    await tx
      .delete(deviceAccountContexts)
      .where(inArray(deviceAccountContexts.id, [...victimIds]));
    await this.pruneOrphanPrincipals(tx, device.id);

    const activeRemoved =
      device.activeContextId !== null && victimIds.has(device.activeContextId);
    const remaining = contexts.filter((context) => !victimIds.has(context.contextId));
    // "The same principal's other contexts" is only a question when the removal
    // was ABOUT one principal — which is both callers today, and the election
    // falls back to the cross-principal rule when it ever is not.
    const principalIds = new Set(victims.map((context) => context.principalId));
    const removedPrincipalId = principalIds.size === 1 ? victims[0].principalId : null;
    const survivingPrincipals = principals.filter((principal) =>
      remaining.some((context) => context.principalId === principal.id)
    );
    const elected = activeRemoved
      ? electReplacementContext(remaining, survivingPrincipals, removedPrincipalId)
      : remaining.find((context) => context.contextId === device.activeContextId) ?? null;

    await tx
      .update(deviceSessions)
      .set({
        ...this.activeFieldsFor(elected),
        revision: sql`${deviceSessions.revision} + 1`,
      })
      .where(eq(deviceSessions.id, device.id));
  }

  /**
   * Sign-out meaning 2 — remove ONE `principal → account` pair.
   *
   * Never the account across the device: the same managed account reached
   * through a second person is a different session, a different audit actor and
   * a different revocation path, and it stays.
   */
  async removeContext(deviceId: string, contextId: string): Promise<RemoveFromDeviceResult> {
    return this.removeFromDevice(deviceId, (contexts) => {
      const target = contexts.find((context) => context.contextId === contextId);
      return target ? [target] : [];
    });
  }

  /**
   * Sign-out meaning 3 — remove ONE PERSON and every context they reach.
   *
   * And nobody else's: another principal who independently operates the same
   * account keeps their own context, their own session and their own slot.
   */
  async removePrincipal(deviceId: string, principalId: string): Promise<RemoveFromDeviceResult> {
    return this.removeFromDevice(deviceId, (contexts) =>
      contexts.filter((context) => context.principalId === principalId)
    );
  }

  /** The shared body of the two removals: pick victims, delete, re-elect, emit. */
  private async removeFromDevice(
    deviceId: string,
    pick: (contexts: readonly DeviceContextRow[]) => DeviceContextRow[]
  ): Promise<RemoveFromDeviceResult> {
    const db = getDb();
    const device = await this.loadDevice(db, deviceId);
    if (!device) return { ok: false, reason: 'not_found' };

    let removedSessionIds: string[] = [];
    let removedAccountIds: string[] = [];

    const found = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({
          id: deviceSessions.id,
          activeContextId: deviceSessions.activeContextId,
        })
        .from(deviceSessions)
        .where(eq(deviceSessions.id, device.id))
        .for('update');
      if (!locked) return false;

      const contexts = await this.loadContexts(tx, locked.id);
      const principals = await this.loadPrincipals(tx, locked.id);
      const victims = pick(contexts);
      if (victims.length === 0) return false;

      removedSessionIds = victims
        .map((context) => context.sessionId)
        .filter((sessionId): sessionId is string => sessionId !== null);
      removedAccountIds = [...new Set(victims.map((context) => context.accountId))];
      await this.removeContextRows(tx, locked, contexts, principals, victims);
      return true;
    });

    if (!found) return { ok: false, reason: 'not_found' };

    // After the commit, so a rolled-back removal can never have killed a session
    // still referenced by a surviving row.
    for (const sessionId of removedSessionIds) {
      try {
        await sessionService.deactivateSession(sessionId);
      } catch (error) {
        logger.warn('deviceSession.removeFromDevice: deactivate failed', { sessionId, error });
      }
    }

    return {
      ok: true,
      directory: await this.getDirectory(deviceId),
      state: await this.readState(deviceId),
      removedAccountIds,
    };
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
   *
   * Returns the OLD device's new state when it actually detached something, and
   * null when it was a no-op. This method advances `revision`, so the caller has
   * to announce it: a silent advance leaves every client on the old device
   * holding a revision the server has moved past, with no signal to re-fetch and
   * no event that would ever arrive later — the device would only converge on
   * its next mutation, which for a graveyard device may be never. The broadcast
   * lives at the call site rather than here because every socket emit in this
   * codebase does, and because the caller is the only party that knows the
   * detach was part of a larger operation.
   */
  async detachMigratedAccount(
    deviceId: string,
    accountId: string,
    preserveSessionId: string
  ): Promise<DeviceSessionState | null> {
    const db = getDb();
    const current = await this.load(db, deviceId);
    if (!current) return null;
    const entry = current.accounts.find((a) => a.accountId === accountId);
    if (!entry) return null;

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

    const updated = await db.transaction(async (tx) => {
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
      return this.load(tx, deviceId);
    });
    if (!updated) {
      throw new Error(`device_sessions row for "${deviceId}" vanished during detachMigratedAccount`);
    }
    return projectState(updated);
  }

  /**
   * Record on the `sessions` row which device and which account context this
   * session serves, so its access token can carry `device_session_id` /
   * `device_context_id` and have them checked back (issue #937, Phase 6).
   *
   * The device-login lane needs this as a SEPARATE write because its ordering
   * is the reverse of `activateContext`'s: the context row is created by
   * `addAccount` AFTER the session exists, so the ids are not knowable at mint
   * time. The token catches up on the next mint — `getAccessToken` re-mints
   * whenever the stored token disagrees with the row.
   *
   * Best-effort by contract: returns false when the device, the session or the
   * context cannot be resolved. A missing binding costs the token two claims,
   * never a sign-in.
   */
  async bindSessionToContext(deviceId: string, sessionId: string): Promise<boolean> {
    const db = getDb();
    const [context] = await db
      .select({
        deviceSessionId: deviceAccountContexts.deviceSessionId,
        contextId: deviceAccountContexts.id,
      })
      .from(deviceAccountContexts)
      .innerJoin(deviceSessions, eq(deviceAccountContexts.deviceSessionId, deviceSessions.id))
      .where(
        and(
          eq(deviceSessions.deviceId, deviceId),
          eq(deviceAccountContexts.sessionId, sessionId),
          isNull(deviceAccountContexts.revokedAt)
        )
      )
      .limit(1);
    if (!context) return false;

    const updated = await db
      .update(sessions)
      .set({
        deviceSessionId: context.deviceSessionId,
        deviceContextId: context.contextId,
      })
      .where(eq(sessions.sessionId, sessionId));
    if (updated.count === 0) return false;

    // The cached row is what `getAccessToken` compares the stored token
    // against; leaving a stale copy there would hide the drift it exists to
    // detect and the token would never pick the claims up.
    sessionCache.invalidate(sessionId);
    return true;
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
