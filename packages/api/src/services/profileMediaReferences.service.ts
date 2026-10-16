/**
 * A profile's avatar is a use of a file (ADR 0042 D4, stage 4b).
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
import {
  addFileReferences,
  deleteFileReference,
  deleteFileReferencesByIds,
} from './fileRepository';
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

/**
 * Compute the change for one account, reading inside `tx` — the caller holds
 * the account row's lock, so the avatar cannot move under it.
 */
async function planAvatarReferences(
  tx: Transaction,
  userId: string,
  avatar: string | null,
  applicationId: string,
): Promise<ProfileAvatarReferenceChange> {
  const existing = await tx
    .select({ fileId: fileReferences.fileId })
    .from(fileReferences)
    .where(
      and(
        eq(fileReferences.applicationId, applicationId),
        eq(fileReferences.entityType, PROFILE_AVATAR_ENTITY_TYPE),
        eq(fileReferences.entityId, userId),
      ),
    );
  const held = new Set(existing.map((row) => row.fileId));

  let avatarFileId: string | null = null;
  let unreferenceable: ProfileAvatarReferenceChange['unreferenceable'];
  const candidate = avatar?.trim() || null;
  if (candidate) {
    const [file] = await tx
      .select({ id: files.id, ownerUserId: files.ownerUserId, status: files.status })
      .from(files)
      .where(eq(files.id, candidate))
      .limit(1);
    if (!file) unreferenceable = 'not_a_file';
    else if (file.ownerUserId !== userId) unreferenceable = 'not_owner';
    else if (file.status === 'deleted') unreferenceable = 'deleted';
    else avatarFileId = file.id;
  }

  return {
    userId,
    avatarFileId,
    ...(unreferenceable ? { unreferenceable } : {}),
    add: avatarFileId && !held.has(avatarFileId) ? avatarFileId : null,
    remove: [...held].filter((fileId) => fileId !== avatarFileId).sort(),
  };
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
  const plan = await planAvatarReferences(tx, input.userId, input.avatar, input.applicationId);
  if (input.dryRun) return plan;

  for (const fileId of plan.remove) {
    await deleteFileReference(
      fileId,
      {
        applicationId: input.applicationId,
        entityType: PROFILE_AVATAR_ENTITY_TYPE,
        entityId: input.userId,
      },
      undefined,
      tx,
    );
  }
  if (plan.add) {
    await addFileReferences(
      [
        {
          fileId: plan.add,
          applicationId: input.applicationId,
          entityType: PROFILE_AVATAR_ENTITY_TYPE,
          entityId: input.userId,
          createdByUserId: input.userId,
        },
      ],
      tx,
    );
  }
  return plan;
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
}

/** The run's totals; `lastUserId` resumes an unfinished run. */
export interface ProfileMediaReconciliationSummary {
  mode: 'report' | 'apply';
  applicationId: string;
  accountsScanned: number;
  accountsChanged: number;
  referencesAdded: number;
  referencesRemoved: number;
  /** Avatars naming no file, another owner's file, or a deleted one: nothing referenced. */
  unreferenceable: number;
  /** References whose account no longer exists (removed with `apply`). */
  orphanReferences: number;
  lastUserId: string | null;
  complete: boolean;
}

/**
 * The back-fill and repair: every account that has an avatar or holds an Oxy
 * Accounts `avatar` reference, in id order, batched. Each account is planned
 * (and, with `apply`, written) in its own transaction under its row lock —
 * the lock `PUT /users/me` takes too — so a profile edit racing the run is
 * never undone. Idempotent: a second run finds nothing to do.
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
    accountsScanned: 0,
    accountsChanged: 0,
    referencesAdded: 0,
    referencesRemoved: 0,
    unreferenceable: 0,
    orphanReferences: 0,
    lastUserId: options.after ?? null,
    complete: false,
  };

  const holdsAvatarReference = sql`exists (
    select 1 from ${fileReferences}
    where ${fileReferences.applicationId} = ${applicationId}
      and ${fileReferences.entityType} = ${PROFILE_AVATAR_ENTITY_TYPE}
      and ${fileReferences.entityId} = ${users.id}
  )`;

  let batches = 0;
  for (;;) {
    if (options.maxBatches !== undefined && batches >= options.maxBatches) return summary;
    const page = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          summary.lastUserId ? gt(users.id, summary.lastUserId) : undefined,
          or(and(isNotNull(users.avatar), ne(users.avatar, '')), holdsAvatarReference),
        ),
      )
      .orderBy(asc(users.id))
      .limit(batchSize);
    if (page.length === 0) break;
    batches += 1;

    for (const { id } of page) {
      const change = await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ avatar: users.avatar })
          .from(users)
          .where(eq(users.id, id))
          .for('update');
        if (!row) return null;
        return syncProfileAvatarReference(tx, {
          userId: id,
          avatar: row.avatar,
          applicationId,
          dryRun: !options.apply,
        });
      });
      summary.accountsScanned += 1;
      summary.lastUserId = id;
      if (!change) continue;
      if (change.unreferenceable) summary.unreferenceable += 1;
      if (change.add || change.remove.length > 0) {
        summary.accountsChanged += 1;
        summary.referencesAdded += change.add ? 1 : 0;
        summary.referencesRemoved += change.remove.length;
        options.emit?.({ ...change, applied: options.apply });
      }
    }
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
