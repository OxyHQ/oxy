/**
 * Content claims (ADR 0042 D10): the intake, the staff review, and the
 * takedown it decides.
 *
 * ## The intake
 *
 * {@link submitContentClaim} stores a claim as `received`: the claimant's
 * identity and statement SEALED (`content_claim_claimants`), each URL as a
 * target resolved to the Oxy file it names when it names one
 * (`contentClaimUrls.ts`), the first audit event, and the claimant's
 * confirmation email in the outbox — one transaction, so a claim never exists
 * without its record and its email, and an email is never sent for a claim
 * that rolled back.
 *
 * ## The review
 *
 * Every transition is ONE conditional write on the state it leaves, under a
 * row lock on the claim, so two reviewers acting at once cannot both succeed
 * (409 `CONTENT_CLAIM_STATE_CONFLICT`, naming the state it is in now). Each
 * appends its audit event and queues its emails in the same transaction.
 *
 * ## The takedown
 *
 * {@link blockClaimTargets} acts on BYTES: for each chosen target's SHA-256 it
 * puts the hash on `blocked_content_hashes` and moves EVERY live row holding
 * it — any owner's, `active` or `trash` — to `blocked`, under the content-hash
 * locks every insert of those bytes takes (so an upload racing the block is
 * either blocked with the rest or refused). `file.blocked` is queued for the
 * owning application and every referencing one (D9), and an email for each
 * owning account. After commit each row leaves serving: off `public/`, the
 * CDN invalidated (`assetService.leaveServing`, the stage-2 machinery).
 *
 * {@link reinstateClaim} undoes this claim's blocks: its blocklist rows go,
 * and every row whose bytes no OTHER claim still blocks returns to `active`
 * (or to `trash`, when `trashed_at` says it was there), is served again
 * (`enterServing`), and `file.unblocked` is queued.
 */

import crypto from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  CLOSED_CONTENT_CLAIM_STATES,
  CONTENT_CLAIM_ERROR_CODES,
  COUNTER_NOTICE_STATEMENT_VERSION,
  type ContentClaimCounterNotice,
  type ContentClaimCounterNoticeResponse,
  type ContentClaimCounterNoticeView,
  type ContentClaimDetailView,
  type ContentClaimEventAction,
  type ContentClaimEventView,
  type ContentClaimKind,
  type ContentClaimListResponse,
  type ContentClaimState,
  type ContentClaimSubmission,
  type ContentClaimSummaryView,
  type ContentClaimTargetView,
  ERASURE_REQUEST_DEADLINE_DAYS,
  isErasureRequest,
  OPEN_CONTENT_CLAIM_STATES,
} from '@oxy.so/contracts';
import { isUniqueViolation, qualified, uuidv7 } from '@oxy.so/db';
import { getDb, type Transaction } from '../../config/postgres';
import {
  blockedContentHashes,
  CONTENT_CLAIMANT_RETENTION_SECONDS,
  contentClaimClaimants,
  contentClaimCounterNotices,
  contentClaimEvents,
  contentClaimNotifications,
  contentClaimTargets,
  contentClaims,
  type ContentClaimNotificationKind,
  type ContentClaimRow,
  files,
} from '../../db/schema';
import { ApiError, BadRequestError, NotFoundError } from '../../utils/error';
import { logger } from '../../utils/logger';
import { openSecret, sealSecret } from '../../utils/secretBox';
import { assetService } from '../assetServiceSingleton';
import { CONTENT_HASH_LOCK_NAMESPACE } from '../contentHashLock';
import { recordFileEvents } from '../fileEvents.service';
import { findFilesByIds } from '../fileRepository';
import { stillBlocked } from './contentBlocklist';
import { resolveContentUrl } from './contentClaimUrls';

const DAY_MS = 24 * 60 * 60 * 1000;
const REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const REFERENCE_ATTEMPTS = 5;
/** Staff text (a reason, a counter-notice summary, a note): bounded, never blank. */
export const CONTENT_CLAIM_NOTE_MAX_LENGTH = 5000;

/** The claim moved on (or was never in) the state an action needs. */
export class ContentClaimStateConflictError extends ApiError {
  constructor(state: ContentClaimState, action: string) {
    super(
      409,
      `This claim is ${state.replace('_', ' ')}; it cannot be ${action} now.`,
      'CONTENT_CLAIM_STATE_CONFLICT',
      { state },
    );
    this.name = 'ContentClaimStateConflictError';
  }
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/** `OXY-XXXX-XXXX`, Crockford base32 (40 random bits). */
export function newClaimReference(): string {
  const bytes = crypto.randomBytes(8);
  const chars = [...bytes].map((byte) => REFERENCE_ALPHABET[byte % 32]).join('');
  return `OXY-${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

type ClaimantField =
  | 'name'
  | 'email'
  | 'organization'
  | 'signature'
  | 'description'
  | 'originalWorkUrl';

function claimantContext(claimId: string, field: ClaimantField): string {
  return `content-claim|${claimId}|${field}`;
}

function sealClaimant(claimId: string, field: ClaimantField, value: string): string {
  return sealSecret(value, claimantContext(claimId, field));
}

function openClaimant(claimId: string, field: ClaimantField, sealed: string): string {
  return openSecret(sealed, claimantContext(claimId, field));
}

const CLOSED_STATES: readonly ContentClaimState[] = CLOSED_CONTENT_CLAIM_STATES;
const OPEN_STATES: readonly ContentClaimState[] = OPEN_CONTENT_CLAIM_STATES;

function isClosedState(state: ContentClaimState): boolean {
  return CLOSED_STATES.includes(state);
}

/**
 * A claimant row past its `expires_at` is erased whether or not the expiry
 * sweep has deleted it yet (`db/expiry.ts`): every read says so itself.
 */
export function claimantNotExpired() {
  return or(
    isNull(contentClaimClaimants.expiresAt),
    sql`${contentClaimClaimants.expiresAt} > now()`,
  );
}

function cleanNote(note: string | undefined | null, required: boolean): string | null {
  const value = note?.trim() ?? '';
  if (!value) {
    if (required) throw new BadRequestError('A note is required for this action');
    return null;
  }
  if (value.length > CONTENT_CLAIM_NOTE_MAX_LENGTH) {
    throw new BadRequestError(`Keep the note to ${CONTENT_CLAIM_NOTE_MAX_LENGTH} characters`);
  }
  return value;
}

/** Take the content-hash lock of each hash, in ONE order, inside `tx`. */
async function lockContentHashes(tx: Transaction, sha256s: readonly string[]): Promise<void> {
  for (const sha256 of [...new Set(sha256s)].sort()) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${CONTENT_HASH_LOCK_NAMESPACE + sha256}, 0))`,
    );
  }
}

async function appendEvent(
  tx: Transaction,
  event: {
    claimId: string;
    action: ContentClaimEventAction;
    actorUserId: string | null;
    fromState?: ContentClaimState | null;
    toState?: ContentClaimState | null;
    note?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(contentClaimEvents).values({
    claimId: event.claimId,
    action: event.action,
    actorUserId: event.actorUserId,
    fromState: event.fromState ?? null,
    toState: event.toState ?? null,
    note: event.note ?? null,
    details: event.details ?? {},
  });
}

async function queueNotifications(
  tx: Transaction,
  claimId: string,
  kind: ContentClaimNotificationKind,
  recipients: { claimant?: boolean; accountIds?: readonly string[] },
): Promise<number> {
  const values: (typeof contentClaimNotifications.$inferInsert)[] = [];
  if (recipients.claimant) values.push({ claimId, kind, recipient: 'claimant' });
  for (const accountId of new Set(recipients.accountIds ?? [])) {
    values.push({ claimId, kind, recipient: 'account', recipientUserId: accountId });
  }
  if (values.length > 0) await tx.insert(contentClaimNotifications).values(values);
  return values.length;
}

/** Lock the claim row; 404 when there is none. */
async function lockClaim(tx: Transaction, claimId: string): Promise<ContentClaimRow> {
  const [row] = await tx
    .select()
    .from(contentClaims)
    .where(eq(contentClaims.id, claimId))
    .for('update');
  if (!row) throw new NotFoundError('Content claim not found');
  return row;
}

/**
 * Move a LOCKED claim from one of `from` to `to`; 409 otherwise. Closing it
 * stamps `closed_at` and starts the claimant statement's retention clock.
 */
async function transition(
  tx: Transaction,
  claim: ContentClaimRow,
  from: readonly ContentClaimState[],
  to: ContentClaimState,
  action: string,
  now: Date,
): Promise<void> {
  if (!from.includes(claim.state)) throw new ContentClaimStateConflictError(claim.state, action);
  const closing = isClosedState(to);
  const updated = await tx
    .update(contentClaims)
    .set({ state: to, ...(closing ? { closedAt: now } : {}) })
    .where(and(eq(contentClaims.id, claim.id), inArray(contentClaims.state, [...from])))
    .returning({ id: contentClaims.id });
  if (updated.length !== 1) throw new ContentClaimStateConflictError(claim.state, action);
  if (closing) {
    // The claimant's statement and every owner's counter-notice go on one clock.
    const expiresAt = new Date(now.getTime() + CONTENT_CLAIMANT_RETENTION_SECONDS * 1000);
    await tx
      .update(contentClaimClaimants)
      .set({ expiresAt })
      .where(eq(contentClaimClaimants.claimId, claim.id));
    await tx
      .update(contentClaimCounterNotices)
      .set({ expiresAt })
      .where(eq(contentClaimCounterNotices.claimId, claim.id));
  }
}

// ---------------------------------------------------------------------------
// The intake
// ---------------------------------------------------------------------------

export interface SubmitContentClaimOptions {
  /** The signed-in account that submitted it, when there is one. */
  submittedByUserId: string | null;
  /** The hosts the Oxy API answers on (the request's own, and the canonical). */
  apiHosts: readonly string[];
  /** The CDN host; defaults to `ASSET_CDN_URL`'s. */
  cdnHost?: string | null;
  now?: Date;
}

/** Store a claim, its targets, its first event and its confirmation email. */
export async function submitContentClaim(
  input: ContentClaimSubmission,
  options: SubmitContentClaimOptions,
): Promise<{ id: string; reference: string }> {
  const now = options.now ?? new Date();
  const urls = [...new Set(input.contentUrls)];
  const resolved = await Promise.all(
    urls.map(async (url) => ({
      url,
      ...(await resolveContentUrl(url, { apiHosts: options.apiHosts, cdnHost: options.cdnHost })),
    })),
  );
  const erasure = isErasureRequest(input.kind, input.claimant.relationship);

  for (let attempt = 1; ; attempt += 1) {
    const id = uuidv7();
    const reference = newClaimReference();
    try {
      await getDb().transaction(async (tx) => {
        await tx.insert(contentClaims).values({
          id,
          reference,
          kind: input.kind,
          relationship: input.claimant.relationship,
          submittedByUserId: options.submittedByUserId,
          deadlineAt: erasure
            ? new Date(now.getTime() + ERASURE_REQUEST_DEADLINE_DAYS * DAY_MS)
            : null,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(contentClaimClaimants).values({
          claimId: id,
          nameCiphertext: sealClaimant(id, 'name', input.claimant.name),
          emailCiphertext: sealClaimant(id, 'email', input.claimant.email),
          organizationCiphertext: input.claimant.organization
            ? sealClaimant(id, 'organization', input.claimant.organization)
            : null,
          signatureCiphertext: sealClaimant(id, 'signature', input.signature),
          descriptionCiphertext: sealClaimant(id, 'description', input.description),
          originalWorkUrlCiphertext: input.originalWorkUrl
            ? sealClaimant(id, 'originalWorkUrl', input.originalWorkUrl)
            : null,
        });
        const seenFiles = new Set<string>();
        const targets = resolved.filter((target) => {
          if (target.resolution !== 'file') return true;
          if (seenFiles.has(target.fileId)) return false;
          seenFiles.add(target.fileId);
          return true;
        });
        await tx.insert(contentClaimTargets).values(
          targets.map((target) => ({
            claimId: id,
            source: 'claimant' as const,
            url: target.url,
            resolution: target.resolution,
            fileId: target.resolution === 'file' ? target.fileId : null,
            sha256: target.resolution === 'file' ? target.sha256 : null,
          })),
        );
        await appendEvent(tx, {
          claimId: id,
          action: 'submitted',
          actorUserId: options.submittedByUserId,
          toState: 'received',
          details: {
            targets: targets.length,
            resolved: targets.filter((target) => target.resolution === 'file').length,
            erasureRequest: erasure,
          },
        });
        await queueNotifications(tx, id, 'claim_received', { claimant: true });
      });
      logger.info('[ContentClaims] Claim received', {
        claimId: id,
        kind: input.kind,
        targets: resolved.length,
      });
      return { id, reference };
    } catch (error) {
      if (
        attempt < REFERENCE_ATTEMPTS &&
        isUniqueViolation(error, 'content_claims_reference_key')
      ) {
        continue;
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// The queue and the detail
// ---------------------------------------------------------------------------

export type ContentClaimDeadlineFilter = 'overdue' | 'due_soon' | 'any';

export interface ListContentClaimsOptions {
  states?: readonly ContentClaimState[];
  kinds?: readonly ContentClaimKind[];
  /** Only claims with a statutory deadline: past it, within 7 days of it, or any. */
  deadline?: ContentClaimDeadlineFilter;
  limit: number;
  cursor?: string;
  now?: Date;
}

/** Days before an erasure deadline the queue calls it "due soon". */
export const CONTENT_CLAIM_DUE_SOON_DAYS = 7;

interface QueueCursor {
  /** Sort key: the deadline (deadline sort) or the received time, as ms. */
  t: number;
  id: string;
}

function encodeCursor(cursor: QueueCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(raw: string): QueueCursor {
  try {
    const value = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as Partial<QueueCursor>;
    if (typeof value.t === 'number' && typeof value.id === 'string')
      return { t: value.t, id: value.id };
  } catch {
    // fall through
  }
  throw new BadRequestError('Invalid cursor');
}

// `qualified`: a bare column in a correlated subquery resolves against the
// subquery's own table (`schema/CONVENTIONS.md`, "the second guise").
const targetCount = sql<number>`(select count(*)::int from content_claim_targets ct where ct.claim_id = ${qualified(contentClaims.id)})`;
const blockedTargetCount = sql<number>`(select count(*)::int from content_claim_targets ct where ct.claim_id = ${qualified(contentClaims.id)} and ct.blocked_at is not null and ct.unblocked_at is null)`;

function summaryOf(
  row: ContentClaimRow & { targetCount: number; blockedTargetCount: number },
): ContentClaimSummaryView {
  return {
    id: row.id,
    reference: row.reference,
    kind: row.kind,
    relationship: row.relationship,
    state: row.state,
    deadlineAt: row.deadlineAt?.toISOString() ?? null,
    targetCount: row.targetCount,
    blockedTargetCount: row.blockedTargetCount,
    receivedAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}

/**
 * One page of the queue. Newest first; with a `deadline` filter, the claims
 * that have one (erasure requests), soonest due first, open ones only.
 */
export async function listContentClaims(
  options: ListContentClaimsOptions,
): Promise<ContentClaimListResponse> {
  const now = options.now ?? new Date();
  const byDeadline = options.deadline !== undefined;
  const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
  const filters = [
    options.states?.length ? inArray(contentClaims.state, [...options.states]) : undefined,
    options.kinds?.length ? inArray(contentClaims.kind, [...options.kinds]) : undefined,
  ];
  if (byDeadline) {
    filters.push(
      isNotNull(contentClaims.deadlineAt),
      inArray(contentClaims.state, [...OPEN_STATES]),
    );
    if (options.deadline === 'overdue') filters.push(lt(contentClaims.deadlineAt, now));
    if (options.deadline === 'due_soon') {
      filters.push(
        lte(
          contentClaims.deadlineAt,
          new Date(now.getTime() + CONTENT_CLAIM_DUE_SOON_DAYS * DAY_MS),
        ),
      );
    }
  }
  if (cursor) {
    const at = new Date(cursor.t);
    filters.push(
      byDeadline
        ? or(
            sql`${contentClaims.deadlineAt} > ${at}`,
            and(eq(contentClaims.deadlineAt, at), sql`${contentClaims.id} > ${cursor.id}`),
          )
        : or(
            lt(contentClaims.createdAt, at),
            and(eq(contentClaims.createdAt, at), lt(contentClaims.id, cursor.id)),
          ),
    );
  }

  const rows = await getDb()
    .select({
      claim: contentClaims,
      targetCount,
      blockedTargetCount,
    })
    .from(contentClaims)
    .where(and(...filters))
    .orderBy(
      ...(byDeadline
        ? [asc(contentClaims.deadlineAt), asc(contentClaims.id)]
        : [desc(contentClaims.createdAt), desc(contentClaims.id)]),
    )
    .limit(options.limit + 1);

  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    claims: page.map((row) =>
      summaryOf({
        ...row.claim,
        targetCount: row.targetCount,
        blockedTargetCount: row.blockedTargetCount,
      }),
    ),
    nextCursor:
      rows.length > options.limit && last
        ? encodeCursor({
            t: (byDeadline
              ? (last.claim.deadlineAt ?? last.claim.createdAt)
              : last.claim.createdAt
            ).getTime(),
            id: last.claim.id,
          })
        : null,
  };
}

function ownerKindOf(row: { ownerUserId: string | null; ownerApplicationId: string | null }) {
  if (row.ownerUserId) return 'account' as const;
  if (row.ownerApplicationId) return 'application' as const;
  return 'platform' as const;
}

/** A claim in full, the claimant's statement opened. */
export async function getContentClaim(claimId: string): Promise<ContentClaimDetailView> {
  const db = getDb();
  const [row] = await db
    .select({ claim: contentClaims, targetCount, blockedTargetCount })
    .from(contentClaims)
    .where(eq(contentClaims.id, claimId))
    .limit(1);
  if (!row) throw new NotFoundError('Content claim not found');
  const claim = row.claim;

  const [claimantRow] = await db
    .select()
    .from(contentClaimClaimants)
    .where(and(eq(contentClaimClaimants.claimId, claimId), claimantNotExpired()))
    .limit(1);

  const targetRows = await db
    .select({
      target: contentClaimTargets,
      file: {
        id: files.id,
        status: files.status,
        visibility: files.visibility,
        mime: files.mime,
        size: files.size,
        ownerUserId: files.ownerUserId,
        ownerApplicationId: files.ownerApplicationId,
      },
    })
    .from(contentClaimTargets)
    .leftJoin(files, eq(files.id, contentClaimTargets.fileId))
    .where(eq(contentClaimTargets.claimId, claimId))
    .orderBy(asc(contentClaimTargets.createdAt), asc(contentClaimTargets.id));

  const eventRows = await db
    .select()
    .from(contentClaimEvents)
    .where(eq(contentClaimEvents.claimId, claimId))
    .orderBy(asc(contentClaimEvents.createdAt), asc(contentClaimEvents.id));

  const targets: ContentClaimTargetView[] = targetRows.map(({ target, file }) => ({
    id: target.id,
    source: target.source,
    url: target.url,
    resolution: target.resolution,
    fileId: target.fileId,
    sha256: target.sha256,
    file: file
      ? {
          id: file.id,
          status: file.status,
          visibility: file.visibility,
          mime: file.mime,
          size: file.size,
          ownerKind: ownerKindOf(file),
          ownerUserId: file.ownerUserId,
          ownerApplicationId: file.ownerApplicationId,
        }
      : null,
    blockedAt: target.blockedAt?.toISOString() ?? null,
    unblockedAt: target.unblockedAt?.toISOString() ?? null,
    createdAt: target.createdAt.toISOString(),
  }));

  const counterNotices = await listCounterNoticeViews(claimId);

  const events: ContentClaimEventView[] = eventRows.map((event) => ({
    id: event.id,
    action: event.action,
    actorUserId: event.actorUserId,
    fromState: event.fromState,
    toState: event.toState,
    note: event.note,
    details: event.details,
    createdAt: event.createdAt.toISOString(),
  }));

  return {
    ...summaryOf({
      ...claim,
      targetCount: row.targetCount,
      blockedTargetCount: row.blockedTargetCount,
    }),
    submittedByUserId: claim.submittedByUserId,
    claimant: claimantRow
      ? {
          name: openClaimant(claimId, 'name', claimantRow.nameCiphertext),
          email: openClaimant(claimId, 'email', claimantRow.emailCiphertext),
          organization: claimantRow.organizationCiphertext
            ? openClaimant(claimId, 'organization', claimantRow.organizationCiphertext)
            : null,
          signature: openClaimant(claimId, 'signature', claimantRow.signatureCiphertext),
          description: openClaimant(claimId, 'description', claimantRow.descriptionCiphertext),
          originalWorkUrl: claimantRow.originalWorkUrlCiphertext
            ? openClaimant(claimId, 'originalWorkUrl', claimantRow.originalWorkUrlCiphertext)
            : null,
        }
      : null,
    claimantExpiresAt: claimantRow?.expiresAt?.toISOString() ?? null,
    targets,
    events,
    counterNotices,
  };
}

/** One target of one claim, with its file id: the preview's authorization. */
export async function findClaimTarget(
  claimId: string,
  targetId: string,
): Promise<{ id: string; fileId: string | null } | null> {
  const [row] = await getDb()
    .select({ id: contentClaimTargets.id, fileId: contentClaimTargets.fileId })
    .from(contentClaimTargets)
    .where(and(eq(contentClaimTargets.id, targetId), eq(contentClaimTargets.claimId, claimId)))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// The review
// ---------------------------------------------------------------------------

export interface StaffAction {
  actorUserId: string;
  now?: Date;
}

/** `received → reviewing`. */
export async function startContentClaimReview(claimId: string, action: StaffAction): Promise<void> {
  const now = action.now ?? new Date();
  await getDb().transaction(async (tx) => {
    const claim = await lockClaim(tx, claimId);
    await transition(tx, claim, ['received'], 'reviewing', 'reviewed', now);
    await appendEvent(tx, {
      claimId,
      action: 'review_started',
      actorUserId: action.actorUserId,
      fromState: claim.state,
      toState: 'reviewing',
    });
  });
}

/**
 * Staff attach files by id — what an unresolved page URL shows, or anything
 * else the claim covers. Each becomes a `staff` target (once per file per
 * claim). Allowed while the claim can still lead to a block.
 */
export async function attachClaimTargets(
  claimId: string,
  action: StaffAction & { fileIds: readonly string[]; url?: string | null },
): Promise<{ attached: string[]; alreadyAttached: string[] }> {
  const fileIds = [...new Set(action.fileIds)];
  if (fileIds.length === 0) throw new BadRequestError('Name at least one file id');
  return getDb().transaction(async (tx) => {
    const claim = await lockClaim(tx, claimId);
    if (!['received', 'reviewing', 'actioned'].includes(claim.state)) {
      throw new ContentClaimStateConflictError(claim.state, 'given more files');
    }
    const found = await tx
      .select({ id: files.id, sha256: files.sha256 })
      .from(files)
      .where(inArray(files.id, fileIds));
    const missing = fileIds.filter((id) => !found.some((row) => row.id === id));
    if (missing.length > 0) {
      throw new ApiError(404, 'No file has this id', 'FILE_NOT_FOUND', { fileIds: missing });
    }
    const inserted = await tx
      .insert(contentClaimTargets)
      .values(
        found.map((row) => ({
          claimId,
          source: 'staff' as const,
          url: action.url ?? null,
          resolution: 'file' as const,
          fileId: row.id,
          sha256: row.sha256,
        })),
      )
      .onConflictDoNothing({
        target: [contentClaimTargets.claimId, contentClaimTargets.fileId],
        where: sql`${contentClaimTargets.fileId} is not null`,
      })
      .returning({ fileId: contentClaimTargets.fileId });
    const attached = inserted.map((row) => row.fileId).filter((id): id is string => id !== null);
    await appendEvent(tx, {
      claimId,
      action: 'targets_attached',
      actorUserId: action.actorUserId,
      details: { fileIds: attached, ...(action.url ? { url: action.url } : {}) },
    });
    return { attached, alreadyAttached: fileIds.filter((id) => !attached.includes(id)) };
  });
}

/** What a block did. */
export interface BlockResult {
  targetsBlocked: number;
  hashesBlocked: number;
  filesBlocked: number;
  ownersNotified: number;
}

/**
 * Block targets (all the claim's unblocked file targets, or the ones named):
 * `reviewing → actioned` the first time, and further blocks while `actioned`.
 */
export async function blockClaimTargets(
  claimId: string,
  action: StaffAction & { targetIds?: readonly string[]; note?: string | null },
): Promise<BlockResult> {
  const now = action.now ?? new Date();
  const note = cleanNote(action.note, false);
  const outcome = await getDb().transaction(async (tx) => {
    const claim = await lockClaim(tx, claimId);
    if (claim.state !== 'reviewing' && claim.state !== 'actioned') {
      throw new ContentClaimStateConflictError(claim.state, 'acted on');
    }
    const eligible = await tx
      .select({ id: contentClaimTargets.id, sha256: contentClaimTargets.sha256 })
      .from(contentClaimTargets)
      .where(
        and(
          eq(contentClaimTargets.claimId, claimId),
          eq(contentClaimTargets.resolution, 'file'),
          isNull(contentClaimTargets.blockedAt),
        ),
      );
    let chosen = eligible;
    if (action.targetIds) {
      const wanted = new Set(action.targetIds);
      chosen = eligible.filter((target) => wanted.has(target.id));
      const refused = [...wanted].filter((id) => !chosen.some((target) => target.id === id));
      if (refused.length > 0) {
        throw new ApiError(
          400,
          'These targets cannot be blocked: they are not this claim’s, name no file, or are already blocked',
          'CONTENT_CLAIM_TARGETS_NOT_BLOCKABLE',
          { targetIds: refused },
        );
      }
    }
    if (chosen.length === 0) {
      throw new ApiError(
        400,
        'Nothing to block: attach the files this claim covers first',
        'CONTENT_CLAIM_NOTHING_TO_BLOCK',
      );
    }
    const hashes = [
      ...new Set(chosen.map((target) => target.sha256).filter((sha): sha is string => !!sha)),
    ].sort();

    await lockContentHashes(tx, hashes);
    await tx
      .insert(blockedContentHashes)
      .values(hashes.map((sha256) => ({ sha256, claimId })))
      .onConflictDoNothing();
    const blocked = await tx
      .update(files)
      .set({ status: 'blocked' })
      .where(and(inArray(files.sha256, hashes), inArray(files.status, ['active', 'trash'])))
      .returning({ id: files.id, ownerUserId: files.ownerUserId });
    await recordFileEvents(
      tx,
      'file.blocked',
      blocked.map((row) => row.id),
      { occurredAt: now },
    );
    await tx
      .update(contentClaimTargets)
      .set({ blockedAt: now })
      .where(
        inArray(
          contentClaimTargets.id,
          chosen.map((target) => target.id),
        ),
      );

    const fromState = claim.state;
    if (fromState === 'reviewing') {
      await transition(tx, claim, ['reviewing'], 'actioned', 'acted on', now);
      await queueNotifications(tx, claimId, 'claim_actioned', { claimant: true });
    }
    const owners = [
      ...new Set(blocked.map((row) => row.ownerUserId).filter((id): id is string => !!id)),
    ];
    const ownersNotified = await queueNotifications(tx, claimId, 'content_blocked', {
      accountIds: owners,
    });
    await appendEvent(tx, {
      claimId,
      action: 'targets_blocked',
      actorUserId: action.actorUserId,
      fromState,
      toState: 'actioned',
      note,
      details: {
        targetIds: chosen.map((target) => target.id),
        hashes: hashes.length,
        filesBlocked: blocked.length,
        accountsNotified: ownersNotified,
      },
    });
    return {
      fileIds: blocked.map((row) => row.id),
      result: {
        targetsBlocked: chosen.length,
        hashesBlocked: hashes.length,
        filesBlocked: blocked.length,
        ownersNotified,
      },
    };
  });

  // Off the CDN, now that the status is committed (and every read path
  // already refuses a blocked file). Best effort per file: what fails is
  // retried by the lifecycle sweep's `unpublishTrashed` step.
  for (const file of await findFilesByIds(outcome.fileIds)) {
    await assetService.leaveServing(file);
  }
  logger.info('[ContentClaims] Targets blocked', { claimId, ...outcome.result });
  return outcome.result;
}

/** `received | reviewing → rejected`, with the reason the claimant is sent. */
export async function rejectContentClaim(
  claimId: string,
  action: StaffAction & { reason: string },
): Promise<void> {
  const now = action.now ?? new Date();
  const reason = cleanNote(action.reason, true);
  await getDb().transaction(async (tx) => {
    const claim = await lockClaim(tx, claimId);
    await transition(tx, claim, ['received', 'reviewing'], 'rejected', 'rejected', now);
    await appendEvent(tx, {
      claimId,
      action: 'rejected',
      actorUserId: action.actorUserId,
      fromState: claim.state,
      toState: 'rejected',
      note: reason,
    });
    await queueNotifications(tx, claimId, 'claim_rejected', { claimant: true });
  });
}

/**
 * `actioned → counter_noticed`: the owner of the blocked content disputes the
 * claim (received at legal@oxy.so). The claimant is sent the summary staff
 * write — not the owner's identity.
 */
export async function recordCounterNotice(
  claimId: string,
  action: StaffAction & { note: string },
): Promise<void> {
  const now = action.now ?? new Date();
  const note = cleanNote(action.note, true);
  await getDb().transaction(async (tx) => {
    const claim = await lockClaim(tx, claimId);
    await transition(tx, claim, ['actioned'], 'counter_noticed', 'counter-noticed', now);
    await appendEvent(tx, {
      claimId,
      action: 'counter_notice_recorded',
      actorUserId: action.actorUserId,
      fromState: claim.state,
      toState: 'counter_noticed',
      note,
    });
    await queueNotifications(tx, claimId, 'claim_counter_noticed', { claimant: true });
  });
}

/** The accounts owning a live row of any of these bytes. */
async function owningAccounts(tx: Transaction, hashes: readonly string[]): Promise<string[]> {
  if (hashes.length === 0) return [];
  const rows = await tx
    .selectDistinct({ ownerUserId: files.ownerUserId })
    .from(files)
    .where(
      and(
        inArray(files.sha256, [...hashes]),
        isNotNull(files.ownerUserId),
        sql`${files.status} <> 'deleted'`,
      ),
    );
  return rows.map((row) => row.ownerUserId).filter((id): id is string => !!id);
}

/**
 * `counter_noticed → reinstated`: this claim's blocks are lifted. Bytes no
 * other claim blocks are served again, from every row that holds them.
 */
export async function reinstateContentClaim(
  claimId: string,
  action: StaffAction & { note?: string | null },
): Promise<{ filesRestored: number }> {
  const now = action.now ?? new Date();
  const note = cleanNote(action.note, false);
  const outcome = await getDb().transaction(async (tx) => {
    const claim = await lockClaim(tx, claimId);
    await transition(tx, claim, ['counter_noticed'], 'reinstated', 'reinstated', now);
    const hashes = (
      await tx
        .select({ sha256: blockedContentHashes.sha256 })
        .from(blockedContentHashes)
        .where(eq(blockedContentHashes.claimId, claimId))
    ).map((row) => row.sha256);
    await lockContentHashes(tx, hashes);
    await tx.delete(blockedContentHashes).where(eq(blockedContentHashes.claimId, claimId));
    const remaining = await stillBlocked(hashes, tx);
    const freed = hashes.filter((sha256) => !remaining.has(sha256));
    const restored =
      freed.length === 0
        ? []
        : await tx
            .update(files)
            .set({
              status: sql`case when ${files.trashedAt} is null then 'active' else 'trash' end`,
            })
            .where(and(inArray(files.sha256, freed), eq(files.status, 'blocked')))
            .returning({ id: files.id, ownerUserId: files.ownerUserId, status: files.status });
    await recordFileEvents(
      tx,
      'file.unblocked',
      restored.map((row) => row.id),
      { occurredAt: now },
    );
    await tx
      .update(contentClaimTargets)
      .set({ unblockedAt: now })
      .where(
        and(eq(contentClaimTargets.claimId, claimId), isNotNull(contentClaimTargets.blockedAt)),
      );
    await queueNotifications(tx, claimId, 'claim_reinstated', { claimant: true });
    const owners = [
      ...new Set(restored.map((row) => row.ownerUserId).filter((id): id is string => !!id)),
    ];
    await queueNotifications(tx, claimId, 'content_reinstated', { accountIds: owners });
    await appendEvent(tx, {
      claimId,
      action: 'reinstated',
      actorUserId: action.actorUserId,
      fromState: claim.state,
      toState: 'reinstated',
      note,
      details: {
        hashes: hashes.length,
        stillBlockedByAnotherClaim: hashes.length - freed.length,
        filesRestored: restored.length,
      },
    });
    return {
      activeIds: restored.filter((row) => row.status === 'active').map((row) => row.id),
      restored: restored.length,
    };
  });
  // Served again: back under `public/` for a public file.
  for (const file of await findFilesByIds(outcome.activeIds)) {
    await assetService.enterServing(file);
  }
  logger.info('[ContentClaims] Claim reinstated', { claimId, filesRestored: outcome.restored });
  return { filesRestored: outcome.restored };
}

/** `counter_noticed → upheld`: the blocks stand, for good. */
export async function upholdContentClaim(
  claimId: string,
  action: StaffAction & { note?: string | null },
): Promise<void> {
  const now = action.now ?? new Date();
  const note = cleanNote(action.note, false);
  await getDb().transaction(async (tx) => {
    const claim = await lockClaim(tx, claimId);
    await transition(tx, claim, ['counter_noticed'], 'upheld', 'upheld', now);
    const hashes = (
      await tx
        .select({ sha256: blockedContentHashes.sha256 })
        .from(blockedContentHashes)
        .where(eq(blockedContentHashes.claimId, claimId))
    ).map((row) => row.sha256);
    await queueNotifications(tx, claimId, 'claim_upheld', { claimant: true });
    await queueNotifications(tx, claimId, 'content_upheld', {
      accountIds: await owningAccounts(tx, hashes),
    });
    await appendEvent(tx, {
      claimId,
      action: 'upheld',
      actorUserId: action.actorUserId,
      fromState: claim.state,
      toState: 'upheld',
      note,
    });
  });
}

/** A note on the trail, in any state. */
export async function addContentClaimNote(
  claimId: string,
  action: StaffAction & { note: string },
): Promise<void> {
  const note = cleanNote(action.note, true);
  await getDb().transaction(async (tx) => {
    await lockClaim(tx, claimId);
    await appendEvent(tx, { claimId, action: 'note_added', actorUserId: action.actorUserId, note });
  });
}

// ---------------------------------------------------------------------------
// The owner's counter-notice (17 U.S.C. § 512(g))
// ---------------------------------------------------------------------------

type CounterNoticeField =
  | 'name'
  | 'address'
  | 'phone'
  | 'email'
  | 'materialDescription'
  | 'materialLocation'
  | 'explanation'
  | 'signature';

function counterNoticeContext(noticeId: string, field: CounterNoticeField): string {
  return `content-claim-counter-notice|${noticeId}|${field}`;
}

export function openCounterNotice(
  noticeId: string,
  field: CounterNoticeField,
  sealed: string,
): string {
  return openSecret(sealed, counterNoticeContext(noticeId, field));
}

/** A counter-notice row past its `expires_at` is erased, swept or not. */
export function counterNoticeNotExpired() {
  return or(
    isNull(contentClaimCounterNotices.expiresAt),
    sql`${contentClaimCounterNotices.expiresAt} > now()`,
  );
}

/** A claim's owners' counter-notices, oldest first, each statement opened (or null once erased). */
async function listCounterNoticeViews(claimId: string): Promise<ContentClaimCounterNoticeView[]> {
  const rows = await getDb()
    .select({
      notice: contentClaimCounterNotices,
      live: sql<boolean>`${contentClaimCounterNotices.expiresAt} is null or ${contentClaimCounterNotices.expiresAt} > now()`,
    })
    .from(contentClaimCounterNotices)
    .where(eq(contentClaimCounterNotices.claimId, claimId))
    .orderBy(asc(contentClaimCounterNotices.createdAt), asc(contentClaimCounterNotices.id));
  return rows.map(({ notice, live }) => ({
    id: notice.id,
    submittedByUserId: notice.submittedByUserId,
    fileIds: notice.fileIds,
    statementVersion: notice.statementVersion,
    statement: live
      ? {
          name: openCounterNotice(notice.id, 'name', notice.nameCiphertext),
          address: openCounterNotice(notice.id, 'address', notice.addressCiphertext),
          phone: openCounterNotice(notice.id, 'phone', notice.phoneCiphertext),
          email: openCounterNotice(notice.id, 'email', notice.emailCiphertext),
          materialDescription: openCounterNotice(
            notice.id,
            'materialDescription',
            notice.materialDescriptionCiphertext,
          ),
          materialLocation: openCounterNotice(
            notice.id,
            'materialLocation',
            notice.materialLocationCiphertext,
          ),
          explanation: openCounterNotice(notice.id, 'explanation', notice.explanationCiphertext),
          signature: openCounterNotice(notice.id, 'signature', notice.signatureCiphertext),
        }
      : null,
    createdAt: notice.createdAt.toISOString(),
  }));
}

/** The claim a counter-notice names is not one this caller may answer — said exactly like no claim. */
function noSuchClaim(): NotFoundError {
  return new NotFoundError('Content claim not found');
}

export interface SubmitCounterNoticeOptions {
  /** The account the session speaks as. */
  subjectUserId: string;
  /** The person operating that session, when it is operated (`resolveOperatorId`). */
  operatorUserId?: string | null;
  now?: Date;
}

/** The caller's blocked files whose bytes `claimId` blocks (all, or those named). */
async function ownersBlockedFiles(
  db: Pick<Transaction, 'select'>,
  claimId: string,
  owners: readonly string[],
  fileIds?: readonly string[],
): Promise<{ id: string; ownerUserId: string }[]> {
  const rows = await db
    .select({ id: files.id, ownerUserId: files.ownerUserId })
    .from(files)
    .where(
      and(
        inArray(files.ownerUserId, [...owners]),
        eq(files.status, 'blocked'),
        inArray(
          files.sha256,
          db
            .select({ sha256: blockedContentHashes.sha256 })
            .from(blockedContentHashes)
            .where(eq(blockedContentHashes.claimId, claimId)),
        ),
        ...(fileIds ? [inArray(files.id, [...fileIds])] : []),
      ),
    )
    .orderBy(asc(files.id));
  return rows.flatMap((row) =>
    row.ownerUserId ? [{ id: row.id, ownerUserId: row.ownerUserId }] : [],
  );
}

/**
 * Which claim the notice answers: the one its `reference` or `claimId` names,
 * else the ONE claim that blocks the bytes of every named file. Anything the
 * caller may not answer — no such claim, a claim blocking none of their files,
 * a file that is not theirs or not blocked — is 404, so a reference or a file
 * id is never an oracle.
 */
async function resolveCounterNoticeClaim(
  input: ContentClaimCounterNotice,
  owners: readonly string[],
): Promise<string> {
  const db = getDb();
  let claimId: string | null = null;
  if (input.reference !== undefined || input.claimId !== undefined) {
    const [row] = await db
      .select({ id: contentClaims.id })
      .from(contentClaims)
      .where(
        and(
          ...(input.reference !== undefined ? [eq(contentClaims.reference, input.reference)] : []),
          ...(input.claimId !== undefined ? [eq(contentClaims.id, input.claimId)] : []),
        ),
      )
      .limit(1);
    if (!row) throw noSuchClaim();
    claimId = row.id;
  }
  if (claimId !== null || input.fileIds === undefined) {
    if (claimId === null) throw noSuchClaim();
    return claimId;
  }

  // Named by files alone: every one must be the caller's, and blocked.
  const fileIds = [...new Set(input.fileIds)];
  const owned = await db
    .select({ id: files.id, sha256: files.sha256 })
    .from(files)
    .where(
      and(
        inArray(files.id, fileIds),
        inArray(files.ownerUserId, [...owners]),
        eq(files.status, 'blocked'),
      ),
    );
  if (owned.length !== fileIds.length) throw noSuchClaim();
  const hashes = [...new Set(owned.map((row) => row.sha256))];
  const claims = await db
    .select({ claimId: blockedContentHashes.claimId })
    .from(blockedContentHashes)
    .where(inArray(blockedContentHashes.sha256, hashes))
    .groupBy(blockedContentHashes.claimId)
    .having(sql`count(distinct ${blockedContentHashes.sha256}) = ${hashes.length}`);
  if (claims.length === 0) throw noSuchClaim();
  if (claims.length > 1) {
    throw new ApiError(
      400,
      'These files were removed after more than one claim. Name the claim by the reference in the email you received.',
      CONTENT_CLAIM_ERROR_CODES.counterNoticeAmbiguous,
    );
  }
  return claims[0].claimId;
}

/**
 * The owner of content a claim took down disputes it (17 U.S.C. § 512(g)(3)).
 *
 * Answers only for files the caller owns — the session's account, or the
 * person operating it — that are `blocked` with bytes on THIS claim's
 * blocklist; anything else is 404, like no claim. Under the claim's row lock:
 * `actioned → counter_noticed` (a claim another owner already answered stays
 * `counter_noticed` and records this notice too; any other state is 409). The
 * notice is SEALED; the trail records `counter_notice_submitted` with the
 * owner as actor; the outbox gets the claimant's copy (§ 512(g)(2)(B)), the
 * owner's confirmation and the staff alert. One per (claim, account): a second
 * is 409 `CONTENT_CLAIM_COUNTER_NOTICE_EXISTS`.
 */
export async function submitCounterNotice(
  input: ContentClaimCounterNotice,
  options: SubmitCounterNoticeOptions,
): Promise<ContentClaimCounterNoticeResponse> {
  const now = options.now ?? new Date();
  const owners = [
    ...new Set([
      options.subjectUserId,
      ...(options.operatorUserId ? [options.operatorUserId] : []),
    ]),
  ];
  const claimId = await resolveCounterNoticeClaim(input, owners);
  const requested = input.fileIds ? [...new Set(input.fileIds)] : undefined;

  try {
    return await getDb().transaction(async (tx) => {
      const claim = await lockClaim(tx, claimId);
      // Re-read under the lock: a reinstatement or an owner's delete cannot
      // slip between the check and the record.
      const covered = await ownersBlockedFiles(tx, claimId, owners, requested);
      if (covered.length === 0 || (requested && covered.length !== requested.length)) {
        throw noSuchClaim();
      }
      if (claim.state === 'actioned') {
        await transition(tx, claim, ['actioned'], 'counter_noticed', 'disputed', now);
      } else if (claim.state !== 'counter_noticed') {
        throw new ContentClaimStateConflictError(claim.state, 'disputed');
      }

      const id = uuidv7();
      const seal = (field: CounterNoticeField, value: string) =>
        sealSecret(value, counterNoticeContext(id, field));
      await tx.insert(contentClaimCounterNotices).values({
        id,
        claimId,
        submittedByUserId: options.subjectUserId,
        fileIds: covered.map((file) => file.id),
        statementVersion: COUNTER_NOTICE_STATEMENT_VERSION,
        nameCiphertext: seal('name', input.subscriber.name),
        addressCiphertext: seal('address', input.subscriber.address),
        phoneCiphertext: seal('phone', input.subscriber.phone),
        emailCiphertext: seal('email', input.subscriber.email),
        materialDescriptionCiphertext: seal('materialDescription', input.material.description),
        materialLocationCiphertext: seal('materialLocation', input.material.location),
        explanationCiphertext: seal('explanation', input.explanation),
        signatureCiphertext: seal('signature', input.signature),
        createdAt: now,
      });
      await appendEvent(tx, {
        claimId,
        action: 'counter_notice_submitted',
        actorUserId: options.subjectUserId,
        fromState: claim.state,
        toState: 'counter_noticed',
        details: { counterNoticeId: id, files: covered.length },
      });
      await tx.insert(contentClaimNotifications).values([
        { claimId, kind: 'claim_counter_notice_copy', recipient: 'claimant', counterNoticeId: id },
        {
          claimId,
          kind: 'counter_notice_received',
          recipient: 'account',
          recipientUserId: options.subjectUserId,
          counterNoticeId: id,
        },
        { claimId, kind: 'counter_notice_staff', recipient: 'staff', counterNoticeId: id },
      ]);
      logger.info('[ContentClaims] Owner counter-notice received', {
        claimId,
        counterNoticeId: id,
        files: covered.length,
      });
      return {
        id,
        reference: claim.reference,
        state: 'counter_noticed' as const,
        fileIds: covered.map((file) => file.id),
      };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'content_claim_counter_notices_claim_id_submitted_by_key')) {
      throw new ApiError(
        409,
        'You already sent a counter-notice for this claim.',
        CONTENT_CLAIM_ERROR_CODES.counterNoticeExists,
      );
    }
    throw error;
  }
}
