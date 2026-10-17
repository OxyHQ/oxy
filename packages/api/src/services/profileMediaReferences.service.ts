/**
 * A profile's avatar is a use of a file (ADR 0043 D4, stage 4b).
 *
 * The Oxy Accounts application uses the file a profile shows as its avatar, so
 * that file is never "not in use" for its person. The reference is the one the
 * SDK's `assets.uploadAvatar` has always written — application Oxy Accounts
 * (the legacy `profiles` alias, `utils/legacyFileLinkApplications.ts`), entity
 * type `avatar`, entity id the account's id — created BY the account itself, so
 * ADR 0021's owner-linked predicate holds for Oxy Accounts.
 *
 * Two writers keep it true:
 *  - `user.service.updateUserProfile` (`PUT /users/me`), in the transaction of
 *    the profile write, under the account row's lock that write takes;
 *  - `scripts/reconcile-profile-media-references.ts` — the one-off back-fill
 *    for profiles set before this, and the repair for any other writer of
 *    `users.avatar`.
 *
 * The rule both apply ({@link syncProfileAvatarReference}): exactly the
 * account's current avatar file is referenced, and only when it is the
 * ACCOUNT'S OWN file — another owner's file (or a URL, or an id naming
 * nothing) is not this account's to keep alive, and an application never
 * references another account's private file (D4). Every other `avatar`
 * reference of Oxy Accounts for this account is removed; removing one never
 * trashes the file (D5): it becomes *not in use* for its person.
 *
 * There is no banner: `users` has no banner or cover column, and
 * `updateUserProfile` drops both fields.
 */

import { and, asc, eq, gt, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import { getDb, type Transaction } from '../config/postgres';
import { files } from '../db/schema/files';
import { fileReferences } from '../db/schema/fileReferences';
import { users } from '../db/schema/users';
import { addFileReferences, deleteFileReferencesByIds } from './fileRepository';
import { resolveReferenceApplicationId } from './fileReference.service';

/** The legacy `file_links.app` value the SDK's avatar flow writes: Oxy Accounts. */
export const PROFILE_MEDIA_APP = 'profiles';

/** The entity type of a profile's avatar reference (the SDK's `uploadAvatar`). */
export const PROFILE_AVATAR_ENTITY_TYPE = 'avatar';

/** Oxy Accounts' application id, or `null` when no single active application is it. */
export function resolveProfileMediaApplicationId(): Promise<string | null> {
  return resolveReferenceApplicationId(PROFILE_MEDIA_APP);
}

/** What one account's avatar references need, or did. */
export interface ProfileAvatarReferenceChange {
  userId: string;
  /** The file the avatar names, when it is the account's own live file. */
  avatarFileId: string | null;
  /** Set when the avatar names something that is not the account's own file. */
  unreferenceable?: 'not_a_file' | 'not_owner' | 'deleted';
  /** The reference to add (the avatar file), or `null` when it already exists or none is due. */
  add: string | null;
  /** Files whose avatar reference goes: no longer the avatar. */
  remove: string[];
}

/** One account's plan, with the ids of the reference rows it removes. */
interface AvatarReferencePlan {
  change: ProfileAvatarReferenceChange;
  removeReferenceIds: string[];
}

/**
 * Compute the change for each account, reading inside `tx` — the caller holds
 * the accounts' row locks, so no avatar can move under it. Three statements
 * whatever the number of accounts: the references they hold, and the files
 * their avatars name.
 */
async function planAvatarReferences(
  tx: Transaction,
  accounts: ReadonlyArray<{ userId: string; avatar: string | null }>,
  applicationId: string,
): Promise<AvatarReferencePlan[]> {
  if (accounts.length === 0) return [];
  const existing = await tx
    .select({
      id: fileReferences.id,
      fileId: fileReferences.fileId,
      entityId: fileReferences.entityId,
    })
    .from(fileReferences)
    .where(
      and(
        eq(fileReferences.applicationId, applicationId),
        eq(fileReferences.entityType, PROFILE_AVATAR_ENTITY_TYPE),
        inArray(
          fileReferences.entityId,
          accounts.map((account) => account.userId),
        ),
      ),
    );
  const heldBy = new Map<string, Array<{ id: string; fileId: string }>>();
  for (const row of existing) {
    const held = heldBy.get(row.entityId) ?? [];
    held.push({ id: row.id, fileId: row.fileId });
    heldBy.set(row.entityId, held);
  }

  const candidates = [
    ...new Set(
      accounts
        .map((account) => account.avatar?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const named =
    candidates.length === 0
      ? []
      : await tx
          .select({ id: files.id, ownerUserId: files.ownerUserId, status: files.status })
          .from(files)
          .where(inArray(files.id, candidates));
  const fileById = new Map(named.map((file) => [file.id, file]));

  return accounts.map(({ userId, avatar }) => {
    let avatarFileId: string | null = null;
    let unreferenceable: ProfileAvatarReferenceChange['unreferenceable'];
    const candidate = avatar?.trim() || null;
    if (candidate) {
      const file = fileById.get(candidate);
      if (!file) unreferenceable = 'not_a_file';
      else if (file.ownerUserId !== userId) unreferenceable = 'not_owner';
      else if (file.status === 'deleted') unreferenceable = 'deleted';
      else avatarFileId = file.id;
    }
    const held = heldBy.get(userId) ?? [];
    const removed = held
      .filter((reference) => reference.fileId !== avatarFileId)
      .sort((left, right) => left.fileId.localeCompare(right.fileId));
    return {
      change: {
        userId,
        avatarFileId,
        ...(unreferenceable ? { unreferenceable } : {}),
        add:
          avatarFileId && !held.some((reference) => reference.fileId === avatarFileId)
            ? avatarFileId
            : null,
        remove: removed.map((reference) => reference.fileId),
      },
      removeReferenceIds: removed.map((reference) => reference.id),
    };
  });
}

/**
 * Write the plans inside `tx`: one delete for every reference that goes, one
 * insert for every reference that is added. Removing never trashes a file
 * (D5); the files left with no reference are stamped `unreferenced_since`.
 */
async function applyAvatarReferencePlans(
  tx: Transaction,
  plans: readonly AvatarReferencePlan[],
  applicationId: string,
): Promise<void> {
  await deleteFileReferencesByIds(
    plans.flatMap((plan) => plan.removeReferenceIds),
    tx,
  );
  await addFileReferences(
    plans.flatMap(({ change }) =>
      change.add
        ? [
            {
              fileId: change.add,
              applicationId,
              entityType: PROFILE_AVATAR_ENTITY_TYPE,
              entityId: change.userId,
              createdByUserId: change.userId,
            },
          ]
        : [],
    ),
    tx,
  );
}

/**
 * Make Oxy Accounts' `avatar` references for `userId` say exactly what the
 * profile now shows, inside `tx` (the profile write's transaction). `avatar`
 * is the stored value AFTER the write (`null` when cleared). With `dryRun`,
 * only the plan is computed.
 */
export async function syncProfileAvatarReference(
  tx: Transaction,
  input: { userId: string; avatar: string | null; applicationId: string; dryRun?: boolean },
): Promise<ProfileAvatarReferenceChange> {
  const plans = await planAvatarReferences(
    tx,
    [{ userId: input.userId, avatar: input.avatar }],
    input.applicationId,
  );
  if (!input.dryRun) await applyAvatarReferencePlans(tx, plans, input.applicationId);
  return plans[0].change;
}

/** Options of {@link runProfileMediaReconciliation}. */
export interface ProfileMediaReconciliationOptions {
  apply: boolean;
  /** Accounts per batch (default 200). */
  batchSize?: number;
  /** Resume after this account id. */
  after?: string;
  /** Stop after this many batches (a bounded run). */
  maxBatches?: number;
  /** Receives one record per account that needs (or got) a change. */
  emit?: (record: ProfileAvatarReferenceChange & { applied: boolean }) => void;
  /** Receives the running totals after each committed batch. */
  progress?: (summary: Readonly<ProfileMediaReconciliationSummary>) => void;
}

/** Why a reference goes. */
export type ProfileAvatarRemovalReason =
  /** The account shows another of its own files: the reference names a former avatar. */
  | 'replaced'
  /** The account shows no avatar any more. */
  | 'cleared'
  /** The avatar names nothing referenceable (a URL, another owner's file, a deleted file). */
  | 'unreferenceable';

/** The run's totals; `lastUserId` resumes an unfinished run. */
export interface ProfileMediaReconciliationSummary {
  mode: 'report' | 'apply';
  applicationId: string;
  batches: number;
  accountsScanned: number;
  accountsChanged: number;
  referencesAdded: number;
  referencesRemoved: number;
  /** {@link referencesRemoved} by why each goes. */
  referencesRemovedByReason: Record<ProfileAvatarRemovalReason, number>;
  /** Avatars naming no file, another owner's file, or a deleted one: nothing referenced. */
  unreferenceable: number;
  /** {@link unreferenceable} by what the avatar names. */
  unreferenceableByReason: Record<
    NonNullable<ProfileAvatarReferenceChange['unreferenceable']>,
    number
  >;
  /** References whose account no longer exists (removed with `apply`). */
  orphanReferences: number;
  /** Batches that Postgres aborted (deadlock, serialization) and that ran again. */
  batchRetries: number;
  lastUserId: string | null;
  complete: boolean;
}

/** A batch Postgres aborts to break a deadlock (or a serialization failure) runs again, this many times. */
const BATCH_ATTEMPTS = 3;

/** True for an error Postgres raises to abort one side of a conflict: retrying is safe. */
function isRetryableConflict(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (code === '40P01' || code === '40001') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function removalReason(change: ProfileAvatarReferenceChange): ProfileAvatarRemovalReason {
  if (change.avatarFileId) return 'replaced';
  return change.unreferenceable ? 'unreferenceable' : 'cleared';
}

/**
 * The back-fill and repair: every account that has an avatar or holds an Oxy
 * Accounts `avatar` reference, in id order, a batch per transaction. A batch
 * is read (and, with `apply`, written) under its accounts' row locks — the
 * lock `PUT /users/me` takes too — so a profile edit racing the run is never
 * undone; it waits for the batch, or the batch waits for it. Each batch is a
 * fixed number of statements, whatever its size. Idempotent: a second run
 * finds nothing to do.
 *
 * Then the references naming an account that no longer exists are counted
 * (and removed with `apply`).
 */
export async function runProfileMediaReconciliation(
  options: ProfileMediaReconciliationOptions,
): Promise<ProfileMediaReconciliationSummary> {
  const applicationId = await resolveProfileMediaApplicationId();
  if (!applicationId) {
    throw new Error(
      `"${PROFILE_MEDIA_APP}" names no single active application (Oxy Accounts): run seed:oxy-applications first`,
    );
  }
  const batchSize = options.batchSize ?? 200;
  const db = getDb();
  const summary: ProfileMediaReconciliationSummary = {
    mode: options.apply ? 'apply' : 'report',
    applicationId,
    batches: 0,
    accountsScanned: 0,
    accountsChanged: 0,
    referencesAdded: 0,
    referencesRemoved: 0,
    referencesRemovedByReason: { replaced: 0, cleared: 0, unreferenceable: 0 },
    unreferenceable: 0,
    unreferenceableByReason: { not_a_file: 0, not_owner: 0, deleted: 0 },
    orphanReferences: 0,
    batchRetries: 0,
    lastUserId: options.after ?? null,
    complete: false,
  };

  const holdsAvatarReference = sql`exists (
    select 1 from ${fileReferences}
    where ${fileReferences.applicationId} = ${applicationId}
      and ${fileReferences.entityType} = ${PROFILE_AVATAR_ENTITY_TYPE}
      and ${fileReferences.entityId} = ${users.id}
  )`;

  const runBatch = (after: string | null) =>
    db.transaction(async (tx) => {
      const page = tx
        .select({ id: users.id, avatar: users.avatar })
        .from(users)
        .where(
          and(
            after ? gt(users.id, after) : undefined,
            or(and(isNotNull(users.avatar), ne(users.avatar, '')), holdsAvatarReference),
          ),
        )
        .orderBy(asc(users.id))
        .limit(batchSize);
      // `no key update` is the lock an UPDATE of the row takes, so it orders
      // this batch against `PUT /users/me` without blocking the key-share
      // locks every insert referencing these accounts takes. A report reads.
      const rows = options.apply ? await page.for('no key update') : await page;
      const plans = await planAvatarReferences(
        tx,
        rows.map((row) => ({ userId: row.id, avatar: row.avatar })),
        applicationId,
      );
      if (options.apply) await applyAvatarReferencePlans(tx, plans, applicationId);
      return plans;
    });

  for (;;) {
    if (options.maxBatches !== undefined && summary.batches >= options.maxBatches) return summary;
    let plans: AvatarReferencePlan[] | undefined;
    for (let attempt = 1; plans === undefined; attempt += 1) {
      try {
        plans = await runBatch(summary.lastUserId);
      } catch (error) {
        if (attempt >= BATCH_ATTEMPTS || !isRetryableConflict(error)) throw error;
        summary.batchRetries += 1;
      }
    }
    if (plans.length === 0) break;
    summary.batches += 1;

    // Counted once the batch committed, so a retried batch is counted once.
    for (const { change } of plans) {
      summary.accountsScanned += 1;
      summary.lastUserId = change.userId;
      if (change.unreferenceable) {
        summary.unreferenceable += 1;
        summary.unreferenceableByReason[change.unreferenceable] += 1;
      }
      if (change.add || change.remove.length > 0) {
        summary.accountsChanged += 1;
        summary.referencesAdded += change.add ? 1 : 0;
        summary.referencesRemoved += change.remove.length;
        summary.referencesRemovedByReason[removalReason(change)] += change.remove.length;
        options.emit?.({ ...change, applied: options.apply });
      }
    }
    options.progress?.(summary);
    if (plans.length < batchSize) break;
  }

  const orphans = await db
    .select({ id: fileReferences.id })
    .from(fileReferences)
    .where(
      and(
        eq(fileReferences.applicationId, applicationId),
        eq(fileReferences.entityType, PROFILE_AVATAR_ENTITY_TYPE),
        sql`not exists (select 1 from ${users} where ${users.id} = ${fileReferences.entityId})`,
      ),
    );
  summary.orphanReferences = orphans.length;
  if (options.apply && orphans.length > 0) {
    for (let start = 0; start < orphans.length; start += batchSize) {
      await deleteFileReferencesByIds(orphans.slice(start, start + batchSize).map((row) => row.id));
    }
  }
  summary.complete = true;
  return summary;
}

/** Test seam: the avatar references Oxy Accounts holds for these accounts. */
export async function listProfileAvatarReferences(
  applicationId: string,
  userIds: readonly string[],
): Promise<Array<{ fileId: string; entityId: string; createdByUserId: string | null }>> {
  if (userIds.length === 0) return [];
  return getDb()
    .select({
      fileId: fileReferences.fileId,
      entityId: fileReferences.entityId,
      createdByUserId: fileReferences.createdByUserId,
    })
    .from(fileReferences)
    .where(
      and(
        eq(fileReferences.applicationId, applicationId),
        eq(fileReferences.entityType, PROFILE_AVATAR_ENTITY_TYPE),
        inArray(fileReferences.entityId, [...userIds]),
      ),
    )
    .orderBy(asc(fileReferences.entityId), asc(fileReferences.fileId));
}
