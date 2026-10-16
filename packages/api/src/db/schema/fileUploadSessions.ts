/**
 * `file_upload_sessions` — a resumable, multipart, presigned upload of a large
 * file of any type by an application's service token (ADR 0041 stage 4b).
 *
 * `POST /assets/service/app/uploads` (an application's own file) and
 * `POST /assets/service/user-media/uploads` (an account's, with the act-as
 * authority of `/service/user-media`) open one. The client PUTs the parts
 * straight to S3 on presigned `UploadPart` URLs — no byte passes through the
 * API — and `…/:uploadId/complete` assembles them. Only then does a row in
 * `files` exist, and only after the API has hashed the assembled object itself.
 *
 * ## Why the API re-reads the object
 *
 * The declared SHA-256 is the content's identity: per-owner dedupe, the shared
 * storage key and the takedown blocklist (ADR 0041 D10) all trust it. A single
 * presigned PUT carries it as a checksum S3 enforces (stage 4a). A multipart
 * upload cannot: S3's full-object checksums are CRC-only, and a SHA-256
 * multipart checksum is a hash of the PARTS' hashes, which proves nothing about
 * the whole. So `complete` moves the session to `verifying`, and the worker
 * (`fileUploadSession.worker.ts`) streams the object, hashes it, and only a
 * match becomes a file — under the content-hash lock, re-checking the
 * blocklist. A mismatch deletes the object and fails the session.
 *
 * ## Where the bytes sit before they are a file
 *
 * At a key of the session's own (`content/…/<sha>-<random>.<ext>`), always in
 * the PRIVATE spelling — never under `public/`, which the CDN serves: unverified
 * bytes must not be reachable from Oxy's CDN for the minutes a verification of
 * gigabytes takes. A public file is copied to its `public/` spelling once it is
 * verified.
 *
 * ## Owners without foreign keys
 *
 * The owner (`owner_user_id` | `owner_application_id`) and the uploading
 * application carry no foreign key on purpose: this row is what aborts the S3
 * multipart upload and releases the storage reservation of a session nobody
 * finished, and an owner's deletion must not take that cleanup away (the same
 * reason `storage_byte_reservations.account_id` has none). A session whose owner
 * is gone fails at finalization (`insertFile` refuses it) and its object goes.
 *
 * ## Resume
 *
 * At most one OPEN session (`uploading` or `verifying`) per (owner, sha256):
 * opening the same bytes again answers the open session, and `GET
 * …/:uploadId` lists the parts S3 already holds, so a client that crashed
 * uploads only what is missing.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { files, FILE_VISIBILITIES } from './files';
import { storageByteReservations } from './storageByteReservations';

/** `uploading` → `verifying` → `completed` | `failed`; `uploading` → `aborted`. */
export const FILE_UPLOAD_SESSION_STATUSES = [
  'uploading',
  'verifying',
  'completed',
  'failed',
  'aborted',
] as const;

export type FileUploadSessionStatus = (typeof FILE_UPLOAD_SESSION_STATUSES)[number];

/** The statuses a session can still change from: at most one per (owner, sha256). */
export const OPEN_FILE_UPLOAD_SESSION_STATUSES = ['uploading', 'verifying'] as const;

/** `application`: `/service/app/uploads`; `account`: `/service/user-media/uploads`. */
export const FILE_UPLOAD_SESSION_KINDS = ['application', 'account'] as const;

export type FileUploadSessionKind = (typeof FILE_UPLOAD_SESSION_KINDS)[number];

/** A finished session is kept this long after it finished, so a client can still read its outcome. */
export const FILE_UPLOAD_SESSION_RETENTION_SECONDS = 7 * 24 * 60 * 60;

function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/** The reference an upload registers for the uploading application once it is a file. */
export interface FileUploadSessionReference {
  entityType: string;
  entityId: string;
}

export const fileUploadSessions = pgTable(
  'file_upload_sessions',
  {
    id: generatedId(),
    kind: text({ enum: FILE_UPLOAD_SESSION_KINDS }).notNull(),
    /** The account that will own the file (`kind = 'account'`). No foreign key: see the header. */
    ownerUserId: text(),
    /** The application that will own the file (`kind = 'application'`). No foreign key: see the header. */
    ownerApplicationId: text(),
    /** The application whose service token opened the session; only it may continue it. */
    uploaderApplicationId: text().notNull(),
    /** Declared SHA-256 (lowercase hex) — verified against the assembled object. */
    sha256: text().notNull(),
    /** Declared size in bytes — every part's size and the assembled object's are checked against it. */
    size: bigint({ mode: 'number' }).notNull(),
    mime: text().notNull(),
    /** With its dot (`.pdf`), or empty — as `files.ext`. */
    ext: text().notNull(),
    originalName: text(),
    visibility: text({ enum: FILE_VISIBILITIES }).notNull(),
    metadata: jsonb().$type<Record<string, unknown>>(),
    reference: jsonb().$type<FileUploadSessionReference>(),
    /** Where the parts are assembled: the session's own key, private spelling. */
    stagingKey: text().notNull(),
    /** S3's `UploadId` of the multipart upload at `staging_key`. */
    s3UploadId: text().notNull(),
    partSize: integer().notNull(),
    partCount: integer().notNull(),
    status: text({ enum: FILE_UPLOAD_SESSION_STATUSES }).notNull().default('uploading'),
    /**
     * The storage reservation of a metered owner (a person, or a third-party
     * application's developer, ADR 0041 D3) when storage admission is on.
     * Released when the session ends without becoming a file.
     */
    reservationId: text().references(() => storageByteReservations.id, { onDelete: 'set null' }),
    /** The file the session became. `SET NULL`: the session outlives a later delete of it. */
    fileId: text().references(() => files.id, { onDelete: 'set null' }),
    /** The owner already held these bytes: `file_id` is that file. */
    deduplicated: boolean().notNull().default(false),
    /** The registered reference's outcome (`created` | `exists`), when one was asked for. */
    referenceResult: text(),
    errorCode: text(),
    errorMessage: text(),
    /** Verification attempts (a crashed verifier's lease expires and another task retries). */
    attempts: integer().notNull().default(0),
    leaseOwner: text(),
    leaseExpiresAt: timestamptz(),
    /** An `uploading` session not completed by then is aborted; slid by every part-URL request. */
    expiresAt: timestamptz().notNull(),
    finishedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'file_upload_sessions_owner_check',
      sql`(${t.kind} = 'application' and ${t.ownerApplicationId} is not null and ${t.ownerUserId} is null)
        or (${t.kind} = 'account' and ${t.ownerUserId} is not null and ${t.ownerApplicationId} is null)`,
    ),
    check(
      'file_upload_sessions_status_check',
      sql`${t.status} in (${sql.raw(inList(FILE_UPLOAD_SESSION_STATUSES))})`,
    ),
    check(
      'file_upload_sessions_kind_check',
      sql`${t.kind} in (${sql.raw(inList(FILE_UPLOAD_SESSION_KINDS))})`,
    ),
    check(
      'file_upload_sessions_visibility_check',
      sql`${t.visibility} in (${sql.raw(inList(FILE_VISIBILITIES))})`,
    ),
    check('file_upload_sessions_size_check', sql`${t.size} > 0`),
    check(
      'file_upload_sessions_parts_check',
      sql`${t.partSize} > 0 and ${t.partCount} between 1 and 10000`,
    ),
    check('file_upload_sessions_sha256_check', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'file_upload_sessions_completed_check',
      sql`${t.status} <> 'completed' or ${t.finishedAt} is not null`,
    ),
    // One open session per (owner, bytes): a second open answers the first (resume).
    uniqueIndex('file_upload_sessions_open_application_key')
      .on(t.ownerApplicationId, t.sha256)
      .where(
        sql`${t.ownerApplicationId} is not null and ${t.status} in (${sql.raw(
          inList(OPEN_FILE_UPLOAD_SESSION_STATUSES),
        )})`,
      ),
    uniqueIndex('file_upload_sessions_open_account_key')
      .on(t.ownerUserId, t.sha256)
      .where(
        sql`${t.ownerUserId} is not null and ${t.status} in (${sql.raw(
          inList(OPEN_FILE_UPLOAD_SESSION_STATUSES),
        )})`,
      ),
    // The worker: sessions to verify, and `uploading` sessions past their deadline.
    index('file_upload_sessions_open_status_idx')
      .on(t.status, t.expiresAt)
      .where(sql`${t.status} in (${sql.raw(inList(OPEN_FILE_UPLOAD_SESSION_STATUSES))})`),
    // The expiry sweep's range predicate (`db/expiry.ts`).
    index('file_upload_sessions_finished_at_idx').on(t.finishedAt),
    index('file_upload_sessions_file_id_idx').on(t.fileId),
    index('file_upload_sessions_reservation_id_idx').on(t.reservationId),
  ],
);

export type FileUploadSessionRow = typeof fileUploadSessions.$inferSelect;
