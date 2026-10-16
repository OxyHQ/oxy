/**
 * Sends the emails a content claim queued (`content_claim_notifications`,
 * ADR 0042 D10).
 *
 * At least once, the way `fileEventDelivery.worker.ts` delivers file events:
 * due rows are claimed under a lease (`FOR UPDATE SKIP LOCKED`, so several API
 * tasks share the work), rendered and sent through the platform's system
 * mailer (`smtpOutbound.sendSystem`), and retried with exponential backoff (1
 * minute doubling, capped at 6 hours) until sent or dead-lettered after
 * {@link CONTENT_CLAIM_NOTIFICATION_MAX_ATTEMPTS}.
 *
 * The address and the body are produced at SEND time, never stored: the
 * claimant's address is opened from `content_claim_claimants`, an account's
 * read from `users`, and the body rendered from the claim as it stands. A
 * claimant whose statement the retention sweep erased, or an account without
 * an email, dead-letters the row at once — there is nobody to retry for.
 */

import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { getEnvBoolean, getEnvNumber, getEnvVar } from '../../config/env';
import { getDb, type Database } from '../../config/postgres';
import {
  blockedContentHashes,
  CONTENT_CLAIM_NOTIFICATION_MAX_ATTEMPTS,
  contentClaimClaimants,
  contentClaimCounterNotices,
  contentClaimEvents,
  contentClaimNotifications,
  contentClaimTargets,
  contentClaims,
  type ContentClaimNotificationKind,
  type ContentClaimNotificationRow,
  type ContentClaimRow,
  files,
  users,
} from '../../db/schema';
import { logger } from '../../utils/logger';
import { openSecret } from '../../utils/secretBox';
import { sendSystem } from '../accountEmail.mail';
import {
  type ContentClaimMail,
  type ContentClaimMailContext,
  LEGAL_CONTACT,
  renderContentClaimMail,
} from './contentClaim.mail';
import {
  claimantNotExpired,
  counterNoticeNotExpired,
  openCounterNotice,
} from './contentClaim.service';

export const CONTENT_CLAIM_NOTIFICATION_LEASE_MS = 2 * 60_000;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MAX_RECORDED_ERROR_LENGTH = 500;

/** Delay before attempt `attempts + 1`, after `attempts` failures. */
export function contentClaimNotificationBackoffMs(attempts: number): number {
  const exponent = Math.max(attempts - 1, 0);
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.min(exponent, 20), MAX_BACKOFF_MS);
}

/** What the worker sends through: the system mailer, a seam for tests. */
export type ContentClaimMailSender = (message: ContentClaimMail & { to: string }) => Promise<void>;

export interface ContentClaimNotificationBatchOptions {
  ownerId: string;
  batchSize?: number;
  leaseMs?: number;
  send?: ContentClaimMailSender;
  now?: () => Date;
}

export interface ContentClaimNotificationBatchResult {
  claimed: number;
  sent: number;
  failed: number;
  deadLettered: number;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_RECORDED_ERROR_LENGTH
    ? `${message.slice(0, MAX_RECORDED_ERROR_LENGTH)}…`
    : message;
}

function claimable(db: Database, now: Date, claimedBefore: Date, limit: number) {
  return db
    .select({ id: contentClaimNotifications.id })
    .from(contentClaimNotifications)
    .where(
      and(
        isNull(contentClaimNotifications.sentAt),
        isNull(contentClaimNotifications.failedAt),
        lte(contentClaimNotifications.nextAttemptAt, now),
        or(
          isNull(contentClaimNotifications.claimedAt),
          lt(contentClaimNotifications.claimedAt, claimedBefore),
        ),
      ),
    )
    .orderBy(asc(contentClaimNotifications.nextAttemptAt))
    .limit(limit)
    .for('update', { skipLocked: true });
}

/** A row that cannot be sent to anyone: dead-lettered at once. */
class Undeliverable extends Error {}

/** The note of the latest event of these actions (a reason, a counter-notice summary). */
async function latestNote(
  claimId: string,
  actions: readonly (typeof contentClaimEvents.$inferSelect)['action'][],
): Promise<string | null> {
  const [row] = await getDb()
    .select({ note: contentClaimEvents.note })
    .from(contentClaimEvents)
    .where(
      and(
        eq(contentClaimEvents.claimId, claimId),
        inArray(contentClaimEvents.action, [...actions]),
      ),
    )
    .orderBy(desc(contentClaimEvents.createdAt), desc(contentClaimEvents.id))
    .limit(1);
  return row?.note ?? null;
}

/** The names of an account's files a claim's block reached (blocked now, or restored). */
async function ownerFileNames(
  claimId: string,
  accountId: string,
  kind: ContentClaimNotificationKind,
): Promise<string[]> {
  const db = getDb();
  const hashes =
    kind === 'content_reinstated'
      ? db
          .select({ sha256: contentClaimTargets.sha256 })
          .from(contentClaimTargets)
          .where(
            and(
              eq(contentClaimTargets.claimId, claimId),
              sql`${contentClaimTargets.unblockedAt} is not null`,
            ),
          )
      : db
          .select({ sha256: blockedContentHashes.sha256 })
          .from(blockedContentHashes)
          .where(eq(blockedContentHashes.claimId, claimId));
  const rows = await db
    .select({ id: files.id, originalName: files.originalName })
    .from(files)
    .where(
      and(
        eq(files.ownerUserId, accountId),
        inArray(files.sha256, hashes),
        kind === 'content_reinstated'
          ? inArray(files.status, ['active', 'trash'])
          : eq(files.status, 'blocked'),
      ),
    )
    .orderBy(asc(files.createdAt), asc(files.id));
  return rows.map((row) => row.originalName || `File ${row.id}`);
}

/** Where staff are told of an owner's counter-notice: the mailbox the claim emails name. */
export function contentClaimStaffAddress(): string {
  return getEnvVar('CONTENT_CLAIM_STAFF_EMAIL', LEGAL_CONTACT).trim() || LEGAL_CONTACT;
}

/** The owner's counter-notice a row is about, or Undeliverable once it is erased. */
async function counterNoticeOf(row: ContentClaimNotificationRow) {
  if (!row.counterNoticeId) throw new Undeliverable('A counter-notice email with no notice');
  const [notice] = await getDb()
    .select()
    .from(contentClaimCounterNotices)
    .where(and(eq(contentClaimCounterNotices.id, row.counterNoticeId), counterNoticeNotExpired()))
    .limit(1);
  if (!notice) throw new Undeliverable('The counter-notice was erased; nothing to send');
  return notice;
}

/** The names of the files an owner's counter-notice covers, as it stands. */
async function counterNoticeFileNames(notice: { fileIds: string[] }): Promise<string[]> {
  if (notice.fileIds.length === 0) return [];
  const rows = await getDb()
    .select({ id: files.id, originalName: files.originalName })
    .from(files)
    .where(inArray(files.id, notice.fileIds))
    .orderBy(asc(files.createdAt), asc(files.id));
  return rows.map((row) => row.originalName || `File ${row.id}`);
}

/** Address and render one row. */
async function compose(
  row: ContentClaimNotificationRow,
  claim: ContentClaimRow,
): Promise<ContentClaimMail & { to: string }> {
  const db = getDb();
  if (row.recipient === 'staff') {
    const notice = await counterNoticeOf(row);
    const mail = renderContentClaimMail(row.kind, {
      reference: claim.reference,
      claimKind: claim.kind,
      greetingName: null,
      note: null,
      fileNames: [],
      targetCount: 0,
      fileCount: notice.fileIds.length,
    });
    return { ...mail, to: contentClaimStaffAddress() };
  }
  if (row.recipient === 'claimant') {
    const [claimant] = await db
      .select({
        name: contentClaimClaimants.nameCiphertext,
        email: contentClaimClaimants.emailCiphertext,
      })
      .from(contentClaimClaimants)
      .where(and(eq(contentClaimClaimants.claimId, claim.id), claimantNotExpired()))
      .limit(1);
    if (!claimant) throw new Undeliverable("The claimant's statement was erased; nobody to tell");
    const [{ targets }] = await db
      .select({ targets: sql<number>`count(*)::int` })
      .from(contentClaimTargets)
      .where(
        and(eq(contentClaimTargets.claimId, claim.id), eq(contentClaimTargets.source, 'claimant')),
      );
    // The copy of an owner's counter-notice: the notice itself for a copyright
    // claim (§ 512(g)(2)(B) — the owner affirmed that disclosure); for any
    // other kind only that it is disputed, never who disputes it.
    let counterNotice: ContentClaimMailContext['counterNotice'] = null;
    if (row.kind === 'claim_counter_notice_copy') {
      const notice = await counterNoticeOf(row);
      if (claim.kind === 'copyright') {
        const open = (field: Parameters<typeof openCounterNotice>[1], sealed: string): string =>
          openCounterNotice(notice.id, field, sealed);
        counterNotice = {
          name: open('name', notice.nameCiphertext),
          address: open('address', notice.addressCiphertext),
          phone: open('phone', notice.phoneCiphertext),
          email: open('email', notice.emailCiphertext),
          materialDescription: open('materialDescription', notice.materialDescriptionCiphertext),
          materialLocation: open('materialLocation', notice.materialLocationCiphertext),
          explanation: open('explanation', notice.explanationCiphertext),
          signature: open('signature', notice.signatureCiphertext),
          sentAt: notice.createdAt.toISOString(),
        };
      }
    }
    const note =
      row.kind === 'claim_rejected'
        ? await latestNote(claim.id, ['rejected'])
        : row.kind === 'claim_counter_noticed'
          ? await latestNote(claim.id, ['counter_notice_recorded'])
          : row.kind === 'claim_reinstated'
            ? await latestNote(claim.id, ['reinstated'])
            : null;
    const mail = renderContentClaimMail(row.kind, {
      reference: claim.reference,
      claimKind: claim.kind,
      greetingName: openSecret(claimant.name, `content-claim|${claim.id}|name`),
      note,
      fileNames: [],
      targetCount: targets,
      counterNotice,
    });
    return { ...mail, to: openSecret(claimant.email, `content-claim|${claim.id}|email`) };
  }

  if (!row.recipientUserId) throw new Undeliverable('An account email with no account');
  const [account] = await db
    .select({ email: users.email, username: users.username })
    .from(users)
    .where(eq(users.id, row.recipientUserId))
    .limit(1);
  if (!account?.email) throw new Undeliverable('The account has no email address');
  const fileNames =
    row.kind === 'counter_notice_received'
      ? await counterNoticeFileNames(await counterNoticeOf(row))
      : await ownerFileNames(claim.id, row.recipientUserId, row.kind);
  if (fileNames.length === 0 && row.kind !== 'content_upheld') {
    throw new Undeliverable('None of the account’s files are affected any more');
  }
  const mail = renderContentClaimMail(row.kind, {
    reference: claim.reference,
    claimKind: claim.kind,
    greetingName: account.username ? `@${account.username}` : null,
    note: null,
    fileNames,
    targetCount: 0,
  });
  return { ...mail, to: account.email };
}

export async function runContentClaimNotificationBatch(
  options: ContentClaimNotificationBatchOptions,
): Promise<ContentClaimNotificationBatchResult> {
  const db = getDb();
  const now = options.now ?? (() => new Date());
  const batchSize =
    options.batchSize ?? getEnvNumber('CONTENT_CLAIM_EMAIL_BATCH_SIZE', DEFAULT_BATCH_SIZE);
  const leaseMs = options.leaseMs ?? CONTENT_CLAIM_NOTIFICATION_LEASE_MS;
  const send = options.send ?? sendSystem;
  const claimTime = now();

  const claimed = await db
    .update(contentClaimNotifications)
    .set({ claimedAt: claimTime, claimedBy: options.ownerId })
    .where(
      inArray(
        contentClaimNotifications.id,
        claimable(db, claimTime, new Date(claimTime.getTime() - leaseMs), batchSize),
      ),
    )
    .returning();

  const result: ContentClaimNotificationBatchResult = {
    claimed: claimed.length,
    sent: 0,
    failed: 0,
    deadLettered: 0,
  };
  if (claimed.length === 0) return result;

  const claims = new Map(
    (
      await db
        .select()
        .from(contentClaims)
        .where(inArray(contentClaims.id, [...new Set(claimed.map((row) => row.claimId))]))
    ).map((claim) => [claim.id, claim]),
  );

  const ownedBy = (id: string) =>
    and(
      eq(contentClaimNotifications.id, id),
      eq(contentClaimNotifications.claimedBy, options.ownerId),
      isNull(contentClaimNotifications.sentAt),
    );

  for (const row of claimed) {
    const attempts = row.attempts + 1;
    let error: string | null = null;
    let deadLetter = false;
    try {
      const claim = claims.get(row.claimId);
      if (!claim) throw new Undeliverable('The claim is gone');
      await send(await compose(row, claim));
    } catch (caught) {
      error = describeError(caught);
      deadLetter =
        caught instanceof Undeliverable || attempts >= CONTENT_CLAIM_NOTIFICATION_MAX_ATTEMPTS;
    }

    if (error === null) {
      const sent = await db
        .update(contentClaimNotifications)
        .set({ attempts, sentAt: now(), lastError: null })
        .where(ownedBy(row.id))
        .returning({ id: contentClaimNotifications.id });
      if (sent.length === 1) result.sent += 1;
      continue;
    }

    await db
      .update(contentClaimNotifications)
      .set({
        attempts,
        lastError: error,
        claimedAt: null,
        claimedBy: null,
        nextAttemptAt: new Date(now().getTime() + contentClaimNotificationBackoffMs(attempts)),
        ...(deadLetter ? { failedAt: now() } : {}),
      })
      .where(ownedBy(row.id));
    result.failed += 1;
    if (deadLetter) result.deadLettered += 1;
    // No address and no name: the claim id, the kind and the error only.
    logger.warn('[ContentClaimEmail] Send failed', {
      notificationId: row.id,
      claimId: row.claimId,
      kind: row.kind,
      recipient: row.recipient,
      attempts,
      deadLetter,
      error,
    });
  }

  return result;
}

/** Emails still owed, for the health surface and tests. */
export async function countPendingContentClaimNotifications(): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(contentClaimNotifications)
    .where(
      and(isNull(contentClaimNotifications.sentAt), isNull(contentClaimNotifications.failedAt)),
    );
  return row?.count ?? 0;
}

const WORKER_OWNER_ID = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

async function tick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    await runContentClaimNotificationBatch({ ownerId: WORKER_OWNER_ID });
  } catch (error) {
    logger.error(
      '[ContentClaimEmail] Batch failed',
      error instanceof Error ? error : new Error(String(error)),
    );
  } finally {
    tickInFlight = false;
  }
}

/**
 * ON by default: a claimant is owed the confirmation their reference is in,
 * and an owner is owed word that their content was taken down.
 * `CONTENT_CLAIM_EMAIL_WORKER_ENABLED=false` pauses it; rows accumulate and are
 * sent when it is switched back on.
 */
export function startContentClaimNotificationWorker(): boolean {
  if (!getEnvBoolean('CONTENT_CLAIM_EMAIL_WORKER_ENABLED', true)) {
    logger.info('[ContentClaimEmail] Worker disabled; claim emails are queued, not sent');
    return false;
  }
  if (timer) return true;
  const intervalMs = Math.max(
    getEnvNumber('CONTENT_CLAIM_EMAIL_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS),
    100,
  );
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  logger.info('[ContentClaimEmail] Worker started', { ownerId: WORKER_OWNER_ID, intervalMs });
  return true;
}

export function stopContentClaimNotificationWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
