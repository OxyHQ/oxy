/**
 * Deleting an account — the one workflow, for `DELETE /users/me` and the
 * operator script `scripts/delete-accounts.ts`.
 *
 * The CALLER proves who may delete (the route: the person's own factor and
 * confirmation text; the script: an operator with `--confirm`). This module
 * owns what happens after that, in this order:
 *
 *  1. FINANCIAL HOLDS ARE CHECKED BEFORE ANYTHING IS DESTROYED (issue #972,
 *     section 7.4). Every financial table references `users` with
 *     `ON DELETE RESTRICT`, so without this a person who had ever transacted
 *     lost their mailboxes, backup, sessions and social graph and THEN hit a
 *     foreign key violation. A live subscription, an in-flight reservation or a
 *     live BYOK connection refuses the deletion with a 409 (see
 *     {@link assertAccountDeletable}).
 *  2. The closure fence (`beginAccountClosure`), then every optional datum:
 *     email data, the identity backup, sessions, device sessions, the social
 *     graph.
 *  3. Retained financial records → the account is ARCHIVED; otherwise the row
 *     is deleted. Either way the `account.deleted` event for relying parties
 *     (OxyHQ/Mention#1169) and the storage deletion of the account's uploads
 *     (OxyHQ/Mention#1178) commit in the same transaction.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { identityBackups } from '../db/schema/identityBackups';
import { users } from '../db/schema/users';
import { ConflictError } from '../utils/error';
import { logger } from '../utils/logger';
import graphCache from '../utils/graphCache';
import userCache from '../utils/userCache';
import {
  archiveAccountForRetention,
  beginAccountClosure,
  deleteDisposableWallets,
  describeAccountFinancialHolds,
  type AccountFinancialHolds,
  type RetainedRecordCount,
} from './accountFinancialHolds.service';
import { recordAccountDeletedEvent, type RecordedAccountEvent } from './accountEvents.service';
import { recordAccountStorageDeletion, type RecordedAccountStorageDeletion } from './accountStorageDeletion.service';
import fileCache from '../utils/fileCache';
import { emailService } from './email.service';
import sessionService from './session.service';
import deviceSessionService from './deviceSession.service';
import { userService } from './user.service';

export type AccountDeletionResult =
  | { retained: true; retainedRecords: readonly RetainedRecordCount[]; accountEventId?: string }
  | { retained: false; accountEventId: string };

/**
 * Refuse, with the route's 409s, a deletion something must be dealt with
 * first. Every refusal is a thing the account's OWNER decides, never a side
 * effect of deleting it:
 *
 * - a live subscription — cancelling somebody's payment agreement is not this
 *   workflow's decision, and if Stripe were unreachable the alternative would
 *   leave Stripe billing a customer who no longer exists;
 * - held inference reservations — money neither spent nor returned; they
 *   settle on their own, so this is a wait;
 * - a live BYOK connection (issue #972 section 12) — revoking it is a
 *   declaration to a third party, and deleting around it would orphan the
 *   Kaana-held ciphertext the `RESTRICT` exists to protect.
 */
export function assertAccountDeletable(holds: AccountFinancialHolds): void {
  if (holds.hasLiveSubscription) {
    throw new ConflictError('This account has a live subscription. Cancel it first, then delete the account.', {
      subscriptions: holds.liveSubscriptionIds,
    });
  }
  if (holds.heldReservations > 0) {
    throw new ConflictError('This account has inference reservations still in flight. Try again once they settle.', {
      heldReservations: holds.heldReservations,
    });
  }
  if (holds.hasLiveProviderConnection) {
    throw new ConflictError(
      'This account still holds provider credentials. Revoke each connection first — ' +
        'revoking retires the Kaana-held credential, which deleting the account cannot do for you.',
      { providerConnections: holds.liveProviderConnections },
    );
  }
}

/**
 * Delete (or, with retained financial records, archive) `userId`. The caller
 * has already established that the deletion is wanted and allowed.
 */
export async function deleteAccount(userId: string, username: string | null): Promise<AccountDeletionResult> {
  const holds = await describeAccountFinancialHolds(userId);
  assertAccountDeletable(holds);

  // The durable closure fence, before any optional data goes. Provider-
  // connection creation locks this same account row and requires it to remain
  // active, so no BYOK row can appear after the holds check and be orphaned.
  await beginAccountClosure(userId);

  // Mailboxes, messages and S3 attachments.
  await emailService.deleteAllUserData(userId);
  // Any encrypted off-device identity backup.
  await getDb().delete(identityBackups).where(eq(identityBackups.userId, userId));
  // Every session and every device-session holding, so a deleted account
  // cannot keep minting tokens from a retained secret.
  await sessionService.deactivateAllUserSessions(userId);
  await deviceSessionService.purgeAccountFromAllDevices(userId);
  // Follow edges, blocks, restrictions, and each counterparty's counts — before
  // the row goes, because a cascade tells nobody whose graph just changed.
  await userService.purgeUserSocialGraph(userId);

  if (holds.blocksHardDelete) {
    // RETAIN AND ARCHIVE: receipts, ledger entries, invoices and payments are
    // kept by law, and the row they reference with them. `archived` resolves
    // to no access anywhere (`accountService.resolveEffectiveAccess`); the
    // profile is not anonymised — releasing a handle is a separate decision.
    // The event commits with the archive, never without it. Uploads are
    // optional data, not financial records: the archive deletes the asset rows
    // itself (the `users` cascade never fires here) and records their storage
    // for deletion, in the same commit.
    let archivedEvent: RecordedAccountEvent | undefined;
    let archivedStorage: RecordedAccountStorageDeletion | undefined;
    await archiveAccountForRetention(userId, {
      withinTransaction: async (tx) => {
        archivedEvent = await recordAccountDeletedEvent(tx, { userId, username, retained: true });
        archivedStorage = await recordAccountStorageDeletion(tx, userId, { removeAssetRows: true });
      },
    });
    userCache.invalidate(userId);
    await graphCache.invalidate(userId);
    for (const fileId of archivedStorage?.fileIds ?? []) fileCache.invalidate(fileId);
    logger.info('Account archived with retained financial records', {
      userId,
      username,
      retainedRecords: holds.retainedRecords,
      accountEventId: archivedEvent?.eventId,
      accountEventRecipients: archivedEvent?.recipients,
      storageDeletionFiles: archivedStorage?.fileIds.length ?? 0,
      storageDeletionTargets: archivedStorage?.targets ?? 0,
    });
    return { retained: true, retainedRecords: holds.retainedRecords, accountEventId: archivedEvent?.eventId };
  }

  // The event is recorded in the SAME transaction and before the row goes: its
  // recipients are read from the account's grants and sessions, which cascade
  // with it. So the event exists exactly when the deletion committed. The
  // uploads' asset rows cascade too, so their storage keys are recorded for
  // deletion first, in the same transaction; `accountStorageDeletion.worker.ts`
  // deletes the objects.
  const { deletedEvent, storage } = await getDb().transaction(async (tx) => {
    const recorded = await recordAccountDeletedEvent(tx, { userId, username, retained: false });
    const recordedStorage = await recordAccountStorageDeletion(tx, userId, { removeAssetRows: false });
    // An empty, never-used wallet is not a hold; it goes with the account.
    await deleteDisposableWallets(tx, userId, holds.disposableWalletIds);
    await tx.delete(users).where(eq(users.id, userId));
    return { deletedEvent: recorded, storage: recordedStorage };
  });
  userCache.invalidate(userId);
  await graphCache.invalidate(userId);
  for (const fileId of storage.fileIds) fileCache.invalidate(fileId);
  logger.info('Account deleted', {
    userId,
    username,
    accountEventId: deletedEvent.eventId,
    accountEventRecipients: deletedEvent.recipients,
    storageDeletionFiles: storage.fileIds.length,
    storageDeletionTargets: storage.targets,
  });
  return { retained: false, accountEventId: deletedEvent.eventId };
}
