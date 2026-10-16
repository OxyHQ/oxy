/**
 * Content claims — the takedown of ADR 0043 D10.
 *
 * Anyone can tell Oxy that content on an Oxy service infringes a copyright or
 * a trademark, exposes their personal data, or is illegal (`POST
 * /content-claims`, the Oxy website's "Report content" page). A person on the
 * staff reviews it (the console's claim queue, staff capability
 * `content:claims`), and actioning it BLOCKS the bytes: every live `files` row
 * holding them leaves serving, and nobody can store them again.
 *
 * Seven tables:
 *
 *  - `content_claims` — the claim and its state.
 *  - `content_claim_claimants` — the claimant's identity and statement,
 *    SEALED, and erased on a retention clock once the claim closes.
 *  - `content_claim_targets` — what the claim names: each URL as submitted,
 *    and what it resolved to (an Oxy file, or nothing yet), plus files staff
 *    attached by id.
 *  - `content_claim_events` — the append-only audit trail: who did what, when.
 *  - `content_claim_counter_notices` — an owner's own counter-notice (17
 *    U.S.C. § 512(g)(3)), SEALED like the claimant's statement and erased on
 *    the same clock.
 *  - `content_claim_notifications` — the outbox of emails to the claimant, to
 *    the owners of blocked files and to the staff who review claims.
 *  - `blocked_content_hashes` — the blocklist: a SHA-256 an actioned claim took
 *    down, refused on every upload, import and copy for ANY owner.
 *
 * ## The state machine
 *
 * `received → reviewing → actioned | rejected`, `received → rejected`,
 * `actioned → counter_noticed → reinstated | upheld`. The transitions live in
 * `services/contentClaims/contentClaim.service.ts`, each one a conditional
 * write on the state it leaves, so two reviewers acting at once cannot both
 * succeed. A claim is OPEN in `received`, `reviewing`, `actioned` and
 * `counter_noticed`: its evidence is kept (`storage_object_deletions` defers
 * the bytes it names) and its blocks can still change. `closed_at` is set
 * exactly when it is not (CHECK).
 *
 * ## The erasure deadline
 *
 * A privacy claim by the affected person is the GDPR erasure request (art.
 * 17), which Oxy must answer within one month (art. 12(3)). `deadline_at` is
 * set for exactly those (CHECK), at submission plus
 * `ERASURE_REQUEST_DEADLINE_DAYS`, and the queue sorts and filters by it.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  CLAIMANT_RELATIONSHIPS,
  CLOSED_CONTENT_CLAIM_STATES,
  CONTENT_CLAIM_EVENT_ACTIONS,
  CONTENT_CLAIM_KINDS,
  CONTENT_CLAIM_STATES,
  CONTENT_CLAIM_TARGET_RESOLUTIONS,
  CONTENT_CLAIM_TARGET_SOURCES,
  OPEN_CONTENT_CLAIM_STATES,
} from '@oxy.so/contracts';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import { files } from './files';
import { users } from './users';

/**
 * How long the claimant's identity and statement are kept once the claim
 * closes: three years — the limitation period for a copyright action in the
 * United States (17 U.S.C. § 507(b)) and within the range of the EU member
 * states', so the record outlives any dispute the claim can still give rise
 * to, and then goes. The claim itself (its kind, state, targets and audit
 * trail, none of which names the claimant) stays as long as Oxy keeps the
 * blocks it imposed.
 */
export const CONTENT_CLAIMANT_RETENTION_SECONDS = 3 * 365 * 24 * 60 * 60;

/** How long a sent or dead-lettered claim email row is kept. */
export const CONTENT_CLAIM_NOTIFICATION_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/** 12 attempts at 1, 2, 4 … minutes capped at 6 h: about a day and a half. */
export const CONTENT_CLAIM_NOTIFICATION_MAX_ATTEMPTS = 12;

export const contentClaims = pgTable(
  'content_claims',
  {
    id: generatedId(),
    /**
     * What the claimant quotes: `OXY-XXXX-XXXX` in Crockford base32 (no I, L,
     * O or U, so it reads back over the phone). Random, so a reference says
     * nothing about how many claims Oxy receives.
     */
    reference: text().notNull(),
    kind: text({ enum: CONTENT_CLAIM_KINDS }).notNull(),
    relationship: text({ enum: CLAIMANT_RELATIONSHIPS }).notNull(),
    state: text({ enum: CONTENT_CLAIM_STATES }).notNull().default('received'),
    /**
     * The signed-in account that submitted it, when there was one. The claim
     * never needs one. `SET NULL`: the claim outlives the account; who the
     * claimant IS lives in `content_claim_claimants`, not here.
     */
    submittedByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    /** The statutory answer-by date of an erasure request; NULL for every other claim (CHECK). */
    deadlineAt: timestamptz(),
    /** When it reached `rejected`, `reinstated` or `upheld`; NULL while open (CHECK). */
    closedAt: timestamptz(),
    /** When it was received. */
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('content_claims_reference_key').on(t.reference),
    check('content_claims_kind_check', sql`${t.kind} in (${sql.raw(inList(CONTENT_CLAIM_KINDS))})`),
    check(
      'content_claims_relationship_check',
      sql`${t.relationship} in (${sql.raw(inList(CLAIMANT_RELATIONSHIPS))})`,
    ),
    check(
      'content_claims_state_check',
      sql`${t.state} in (${sql.raw(inList(CONTENT_CLAIM_STATES))})`,
    ),
    check(
      'content_claims_deadline_check',
      sql`(${t.kind} = 'privacy' and ${t.relationship} = 'affected_person') = (${t.deadlineAt} is not null)`,
    ),
    check(
      'content_claims_closed_check',
      sql`(${t.state} in (${sql.raw(inList(CLOSED_CONTENT_CLAIM_STATES))})) = (${t.closedAt} is not null)`,
    ),
    // The queue: newest first within a state, `(created_at, id)` as the cursor.
    index('content_claims_state_created_at_idx').on(t.state, t.createdAt.desc(), t.id.desc()),
    // The queue across states, newest first.
    index('content_claims_created_at_idx').on(t.createdAt.desc(), t.id.desc()),
    // Open erasure requests by how soon they are due.
    index('content_claims_open_deadline_idx')
      .on(t.deadlineAt)
      .where(
        sql`${t.deadlineAt} is not null and ${t.state} in (${sql.raw(inList(OPEN_CONTENT_CLAIM_STATES))})`,
      ),
  ],
);

/**
 * The claimant's identity and statement — personal data, so SEALED at rest
 * (`utils/secretBox.ts`, context `content-claim|<claimId>|<field>`): a database
 * dump alone does not reveal who complained about whom. Only the claim review
 * opens it, for staff holding `content:claims`, and the notification worker,
 * to address the claimant.
 *
 * Both statements (good faith, accuracy) must be affirmed for a claim to exist
 * at all — the API refuses a submission without them — so there is nothing to
 * store about them beyond the claim itself.
 *
 * ## Retention
 *
 * `expires_at` is NULL while the claim is open and set when it closes, to
 * `closed_at` plus {@link CONTENT_CLAIMANT_RETENTION_SECONDS}; the expiry sweep
 * (`db/expiry.ts`) then deletes the row. The claim keeps its kind, state,
 * targets and trail. Reads treat a missing row as "erased".
 */
export const contentClaimClaimants = pgTable(
  'content_claim_claimants',
  {
    /** `CASCADE`: the statement belongs to its claim. */
    claimId: text()
      .primaryKey()
      .references(() => contentClaims.id, { onDelete: 'cascade' }),
    nameCiphertext: text().notNull(),
    emailCiphertext: text().notNull(),
    organizationCiphertext: text(),
    signatureCiphertext: text().notNull(),
    descriptionCiphertext: text().notNull(),
    originalWorkUrlCiphertext: text(),
    /** When the expiry sweep erases this row; NULL while the claim is open. */
    expiresAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    // The expiry sweep's range predicate (`db/expiry.ts`).
    index('content_claim_claimants_expires_at_idx')
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} is not null`),
  ],
);

/**
 * What a claim names. A claimant's URL is kept as submitted (`url`) with what
 * it resolved to: an Oxy file (`resolution = 'file'`, `file_id` and the bytes'
 * `sha256`), or nothing (`unresolved` — a page of an Oxy app, which a person
 * maps to the files it shows by attaching them, `source = 'staff'`).
 *
 * `sha256` is copied from the file when the target is resolved, because the
 * takedown acts on BYTES (every row holding them, and the blocklist), and the
 * file row can go — an account's deletion removes its rows, which is why
 * `file_id` is `SET NULL` rather than refusing that deletion.
 *
 * `blocked_at` / `unblocked_at` record what this target's block did; the
 * blocklist itself is `blocked_content_hashes`.
 */
export const contentClaimTargets = pgTable(
  'content_claim_targets',
  {
    id: generatedId(),
    claimId: text()
      .notNull()
      .references(() => contentClaims.id, { onDelete: 'cascade' }),
    source: text({ enum: CONTENT_CLAIM_TARGET_SOURCES }).notNull(),
    /** The URL as the claimant sent it; for a staff-attached file, the page it came from, if any. */
    url: text(),
    resolution: text({ enum: CONTENT_CLAIM_TARGET_RESOLUTIONS }).notNull(),
    fileId: text().references(() => files.id, { onDelete: 'set null' }),
    sha256: text(),
    blockedAt: timestamptz(),
    unblockedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'content_claim_targets_source_check',
      sql`${t.source} in (${sql.raw(inList(CONTENT_CLAIM_TARGET_SOURCES))})`,
    ),
    check(
      'content_claim_targets_resolution_check',
      sql`${t.resolution} in (${sql.raw(inList(CONTENT_CLAIM_TARGET_RESOLUTIONS))})`,
    ),
    // A claimant's target is a URL; a resolved one names bytes.
    check(
      'content_claim_targets_url_check',
      sql`${t.source} <> 'claimant' or ${t.url} is not null`,
    ),
    check(
      'content_claim_targets_resolved_check',
      sql`(${t.resolution} = 'file') = (${t.sha256} is not null)`,
    ),
    check(
      'content_claim_targets_sha256_check',
      sql`${t.sha256} is null or ${t.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'content_claim_targets_unblocked_check',
      sql`${t.unblockedAt} is null or ${t.blockedAt} is not null`,
    ),
    index('content_claim_targets_claim_id_idx').on(t.claimId, t.createdAt),
    // One target per file per claim.
    uniqueIndex('content_claim_targets_claim_id_file_id_key')
      .on(t.claimId, t.fileId)
      .where(sql`${t.fileId} is not null`),
    // The evidence hold: "does an open claim name these bytes".
    index('content_claim_targets_sha256_idx').on(t.sha256).where(sql`${t.sha256} is not null`),
    // The FK probe `files` deletions run (SET NULL).
    index('content_claim_targets_file_id_idx').on(t.fileId).where(sql`${t.fileId} is not null`),
  ],
);

/**
 * The audit trail: one row per thing that happened to a claim, never edited
 * (no `updated_at`; a trigger refuses an UPDATE — `0171_content_claims`).
 *
 * `actor_user_id` names the staff member who acted, or the signed-in account
 * that submitted; NULL for an anonymous submission and for what the system did
 * on its own. It carries no foreign key on purpose: a trail that loses its
 * actor when their account goes is not a trail (`ID_COLUMNS_WITHOUT_FOREIGN_KEY`).
 *
 * `details` is the action's own shape — the targets attached or blocked, the
 * file and owner counts a block reached — never the claimant's personal data,
 * which lives sealed in `content_claim_claimants` and goes with it.
 */
export const contentClaimEvents = pgTable(
  'content_claim_events',
  {
    id: generatedId(),
    claimId: text()
      .notNull()
      .references(() => contentClaims.id, { onDelete: 'cascade' }),
    action: text({ enum: CONTENT_CLAIM_EVENT_ACTIONS }).notNull(),
    actorUserId: text(),
    fromState: text({ enum: CONTENT_CLAIM_STATES }),
    toState: text({ enum: CONTENT_CLAIM_STATES }),
    /** What staff wrote: a rejection reason, a counter-notice summary, a note. */
    note: text(),
    details: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'content_claim_events_action_check',
      sql`${t.action} in (${sql.raw(inList(CONTENT_CLAIM_EVENT_ACTIONS))})`,
    ),
    check(
      'content_claim_events_state_check',
      sql`(${t.fromState} is null or ${t.fromState} in (${sql.raw(inList(CONTENT_CLAIM_STATES))})) and (${t.toState} is null or ${t.toState} in (${sql.raw(inList(CONTENT_CLAIM_STATES))}))`,
    ),
    index('content_claim_events_claim_id_created_at_idx').on(t.claimId, t.createdAt, t.id),
  ],
);

/** Why an email about a claim is sent. */
export const CONTENT_CLAIM_NOTIFICATION_KINDS = [
  /** To the claimant: we have it, here is the reference. */
  'claim_received',
  /** To the claimant: the content was taken down. */
  'claim_actioned',
  /** To the claimant: we did not act, and why. */
  'claim_rejected',
  /** To the claimant: the owner of the content disputes the claim (a counter-notice). */
  'claim_counter_noticed',
  /** To the claimant: after the owner's counter-notice, the content is back. */
  'claim_reinstated',
  /** To the claimant: after the owner's counter-notice, it stays down. */
  'claim_upheld',
  /** To an owning account: some of your files were blocked after a claim. */
  'content_blocked',
  /** To an owning account: they are served again. */
  'content_reinstated',
  /** To an owning account: after its counter-notice, they stay blocked. */
  'content_upheld',
  /**
   * To the claimant: the copy of an owner's counter-notice (17 U.S.C.
   * § 512(g)(2)(B)) — for a copyright claim the notice itself, the owner's
   * name and contact details included (the owner affirmed that disclosure);
   * for any other kind, that the owner disputes it, without them.
   */
  'claim_counter_notice_copy',
  /** To the owning account: we received your counter-notice. */
  'counter_notice_received',
  /** To the staff who review claims (legal@oxy.so): an owner sent a counter-notice. */
  'counter_notice_staff',
] as const;

/** The kinds that are about ONE owner's counter-notice, and name it. */
export const COUNTER_NOTICE_NOTIFICATION_KINDS = [
  'claim_counter_notice_copy',
  'counter_notice_received',
  'counter_notice_staff',
] as const satisfies readonly (typeof CONTENT_CLAIM_NOTIFICATION_KINDS)[number][];

export type ContentClaimNotificationKind = (typeof CONTENT_CLAIM_NOTIFICATION_KINDS)[number];

/** Who an email goes to: the claimant, an owning account, or the staff mailbox. */
export const CONTENT_CLAIM_NOTIFICATION_RECIPIENTS = ['claimant', 'account', 'staff'] as const;

/**
 * An owner's counter-notice (17 U.S.C. § 512(g)(3)), sent by the owner
 * themselves (`POST /content-claims/counter-notices`) rather than recorded by
 * staff from an email.
 *
 * The owner's identity, contact details and statement are personal data, so
 * SEALED like the claimant's (`utils/secretBox.ts`, context
 * `content-claim-counter-notice|<id>|<field>`), opened only for the review and
 * the notification worker, and erased on the claimant's clock: `expires_at`
 * is NULL while the claim is open and set when it closes, to `closed_at` plus
 * {@link CONTENT_CLAIMANT_RETENTION_SECONDS}; the expiry sweep deletes the
 * row and every read treats a row past it as erased.
 *
 * The four statements must all be affirmed for a notice to exist, so what is
 * stored about them is WHICH wording was affirmed (`statement_version`).
 * `file_ids` are the caller's blocked files the notice covers, as they were
 * when it was sent. One per (claim, account).
 */
export const contentClaimCounterNotices = pgTable(
  'content_claim_counter_notices',
  {
    id: generatedId(),
    /** `CASCADE`: the notice belongs to its claim. */
    claimId: text()
      .notNull()
      .references(() => contentClaims.id, { onDelete: 'cascade' }),
    /** The account that sent it. `SET NULL`: the claim keeps the notice; who sent it is in the statement. */
    submittedByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    fileIds: text().array().notNull(),
    statementVersion: text().notNull(),
    nameCiphertext: text().notNull(),
    addressCiphertext: text().notNull(),
    phoneCiphertext: text().notNull(),
    emailCiphertext: text().notNull(),
    materialDescriptionCiphertext: text().notNull(),
    materialLocationCiphertext: text().notNull(),
    explanationCiphertext: text().notNull(),
    signatureCiphertext: text().notNull(),
    /** When the expiry sweep erases this row; NULL while the claim is open. */
    expiresAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'content_claim_counter_notices_file_ids_check',
      sql`cardinality(${t.fileIds}) between 1 and 50`,
    ),
    index('content_claim_counter_notices_claim_id_idx').on(t.claimId, t.createdAt),
    // One notice per account per claim: a second is a 409, not a second copy to the claimant.
    uniqueIndex('content_claim_counter_notices_claim_id_submitted_by_key')
      .on(t.claimId, t.submittedByUserId)
      .where(sql`${t.submittedByUserId} is not null`),
    // The FK probe a deleted account's SET NULL runs.
    index('content_claim_counter_notices_submitted_by_user_id_idx')
      .on(t.submittedByUserId)
      .where(sql`${t.submittedByUserId} is not null`),
    // The expiry sweep's range predicate (`db/expiry.ts`).
    index('content_claim_counter_notices_expires_at_idx')
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} is not null`),
  ],
);

/**
 * The outbox of claim emails, written in the transaction of the change they
 * announce and sent by `contentClaimNotification.worker.ts`, at least once,
 * with backoff, dead-lettered after
 * {@link CONTENT_CLAIM_NOTIFICATION_MAX_ATTEMPTS}.
 *
 * No address and no content is stored: the claimant's address is opened from
 * `content_claim_claimants` and an account's read from `users` at send time,
 * and the body is rendered then from the claim (a claimant whose statement
 * was erased, or an account with no email, dead-letters the row). So nothing
 * personal is copied here.
 */
export const contentClaimNotifications = pgTable(
  'content_claim_notifications',
  {
    id: generatedId(),
    claimId: text()
      .notNull()
      .references(() => contentClaims.id, { onDelete: 'cascade' }),
    kind: text({ enum: CONTENT_CLAIM_NOTIFICATION_KINDS }).notNull(),
    recipient: text({ enum: CONTENT_CLAIM_NOTIFICATION_RECIPIENTS }).notNull(),
    /** The owning account told, for `recipient = 'account'`. `CASCADE`: nobody left to tell. */
    recipientUserId: text().references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The owner's counter-notice the email is about, for exactly the
     * {@link COUNTER_NOTICE_NOTIFICATION_KINDS} (CHECK). `CASCADE`: an erased
     * notice leaves nothing to send.
     */
    counterNoticeId: text().references(() => contentClaimCounterNotices.id, {
      onDelete: 'cascade',
    }),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamptz().notNull().default(sql`now()`),
    claimedAt: timestamptz(),
    claimedBy: text(),
    sentAt: timestamptz(),
    failedAt: timestamptz(),
    lastError: text(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'content_claim_notifications_kind_check',
      sql`${t.kind} in (${sql.raw(inList(CONTENT_CLAIM_NOTIFICATION_KINDS))})`,
    ),
    check(
      'content_claim_notifications_recipient_check',
      sql`${t.recipient} in (${sql.raw(inList(CONTENT_CLAIM_NOTIFICATION_RECIPIENTS))})`,
    ),
    check(
      'content_claim_notifications_recipient_user_check',
      sql`(${t.recipient} = 'account') = (${t.recipientUserId} is not null)`,
    ),
    check(
      'content_claim_notifications_counter_notice_check',
      sql`(${t.kind} in (${sql.raw(inList(COUNTER_NOTICE_NOTIFICATION_KINDS))})) = (${t.counterNoticeId} is not null)`,
    ),
    check('content_claim_notifications_attempts_check', sql`${t.attempts} >= 0`),
    index('content_claim_notifications_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.sentAt} is null and ${t.failedAt} is null`),
    index('content_claim_notifications_claim_id_idx').on(t.claimId),
    index('content_claim_notifications_counter_notice_id_idx')
      .on(t.counterNoticeId)
      .where(sql`${t.counterNoticeId} is not null`),
    index('content_claim_notifications_recipient_user_id_idx')
      .on(t.recipientUserId)
      .where(sql`${t.recipientUserId} is not null`),
    // The expiry sweep's range predicate (`db/expiry.ts`).
    index('content_claim_notifications_created_at_idx').on(t.createdAt),
  ],
);

/**
 * The blocklist: bytes an actioned claim took down. Every path that stores a
 * file refuses a SHA-256 listed here, for ANY owner (HTTP 451
 * `CONTENT_BLOCKED`, `services/contentClaims/contentBlocklist.ts`, checked under
 * the content-hash lock every insert takes), and every live row holding it is
 * `blocked`.
 *
 * One row per (bytes, claim): two claims can block the same bytes, and
 * reinstating one leaves the other's block standing — bytes are blocked while
 * ANY row names them. `RESTRICT`: a claim is never removed while it blocks
 * something.
 */
export const blockedContentHashes = pgTable(
  'blocked_content_hashes',
  {
    sha256: text().notNull(),
    claimId: text()
      .notNull()
      .references(() => contentClaims.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'blocked_content_hashes_pkey', columns: [t.sha256, t.claimId] }),
    check('blocked_content_hashes_sha256_check', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    // The FK probe and "what does this claim block".
    index('blocked_content_hashes_claim_id_idx').on(t.claimId),
  ],
);

export type ContentClaimRow = typeof contentClaims.$inferSelect;
export type ContentClaimTargetRow = typeof contentClaimTargets.$inferSelect;
export type ContentClaimEventRow = typeof contentClaimEvents.$inferSelect;
export type ContentClaimNotificationRow = typeof contentClaimNotifications.$inferSelect;
export type ContentClaimCounterNoticeRow = typeof contentClaimCounterNotices.$inferSelect;
