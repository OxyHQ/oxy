/**
 * `file_ingests` — bytes Oxy receives or fetches itself before they are a
 * file, when their hash is not known in advance (ADR 0043 stage 4c):
 *
 * - **`import`** — an import by URL whose source is larger than the 40 MiB the
 *   synchronous import streams (a podcast enclosure). The import route answers
 *   `202` with this row's id; the bytes are fetched with the same SSRF-safe
 *   fetcher and streamed to a staging object by S3 multipart, hashed on the
 *   way, and finalized.
 * - **`recording`** — a recording target: S3-compatible credentials scoped to
 *   ONE pending object that a LiveKit egress (or any S3 client) uploads into
 *   (`/assets/recording-ingest`, SigV4-verified, path-style). Once the object
 *   is complete it is read back, hashed and finalized.
 *
 * Both end in `AssetService.finalizeLargeUpload` with the hash Oxy computed —
 * per-owner dedupe, shared storage, the takedown blocklist, a third-party
 * application's plan (`insertFile`'s quota check) — then the reference the
 * creator asked for and, for a person's file, the creator's access grant
 * (`file_access_grants`, `source = 'upload'`).
 *
 * ## Where the bytes sit before they are a file
 *
 * At `staging_key` — this row's own `content/…/ingest/<id><ext>`, ALWAYS in the
 * private spelling: unverified bytes are never under `public/`, which the CDN
 * serves. The file keeps that object (copied to its `public/` spelling for a
 * public file) unless the owner already holds the bytes or another owner's
 * object can be shared.
 *
 * ## Owners without foreign keys
 *
 * As `file_upload_sessions`: this row is what aborts the S3 multipart upload
 * and deletes a staging object nobody finished; an owner's deletion must not
 * take that cleanup away. A row whose owner is gone fails at finalization.
 *
 * ## Secrets
 *
 * A recording target's S3 secret and an import's source URL are sealed with
 * `secretBox` (contexts `file-ingest-secret|<id>` and `file-ingest-source|<id>`);
 * only the source host is in clear.
 */

import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { files, FILE_VISIBILITIES } from './files';

export const FILE_INGEST_SOURCES = ['import', 'recording'] as const;
export type FileIngestSource = (typeof FILE_INGEST_SOURCES)[number];

/**
 * `awaiting_upload` (a recording target nobody wrote to yet) → `receiving`
 * (bytes arriving: an import's fetch, a recording's multipart upload) →
 * `verifying` (the object is complete; hashing and finalizing) → `completed` |
 * `failed`; any open state → `aborted` (the creator, or expiry).
 */
export const FILE_INGEST_STATUSES = [
  'awaiting_upload',
  'receiving',
  'verifying',
  'completed',
  'failed',
  'aborted',
] as const;
export type FileIngestStatus = (typeof FILE_INGEST_STATUSES)[number];

/** The statuses an ingest can still change from. */
export const OPEN_FILE_INGEST_STATUSES = ['awaiting_upload', 'receiving', 'verifying'] as const;

export const FILE_INGEST_KINDS = ['application', 'account'] as const;
export type FileIngestKind = (typeof FILE_INGEST_KINDS)[number];

/** A finished ingest stays readable by its creator for a week. */
export const FILE_INGEST_RETENTION_SECONDS = 7 * 24 * 60 * 60;

function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/** The reference the creator registers for itself once the ingest is a file. */
export interface FileIngestReference {
  entityType: string;
  entityId: string;
}

export const fileIngests = pgTable(
  'file_ingests',
  {
    id: generatedId(),
    source: text({ enum: FILE_INGEST_SOURCES }).notNull(),
    kind: text({ enum: FILE_INGEST_KINDS }).notNull(),
    status: text({ enum: FILE_INGEST_STATUSES }).notNull(),
    /** The account that will own the file (`kind = 'account'`). No foreign key: see the header. */
    ownerUserId: text(),
    /** The application that will own the file (`kind = 'application'`). No foreign key: see the header. */
    ownerApplicationId: text(),
    /** The application whose service token created the ingest; only it may read or continue it. */
    creatorApplicationId: text().notNull(),
    /** The content type, once known (an import's response, a recording's upload). */
    mime: text(),
    /** With its dot, or empty — as `files.ext`. */
    ext: text(),
    originalName: text(),
    visibility: text({ enum: FILE_VISIBILITIES }).notNull(),
    metadata: jsonb().$type<Record<string, unknown>>(),
    reference: jsonb().$type<FileIngestReference>(),
    /** The private staging object, once bytes started arriving. */
    stagingKey: text(),
    /** S3's `UploadId` of a recording's multipart upload at `staging_key`. */
    s3UploadId: text(),
    /** The object name a recording's client wrote (under `<id>/`), for its S3 answers. */
    objectName: text(),
    /** Bytes received, once complete. */
    size: bigint({ mode: 'number' }),
    /** SHA-256 Oxy computed over the received bytes. */
    sha256: text(),
    /** The most bytes this ingest accepts. */
    maxBytes: bigint({ mode: 'number' }).notNull(),
    /** A recording target's S3 secret, sealed (`file-ingest-secret|<id>`). */
    secretCiphertext: text(),
    /** An import's normalized source URL: SHA-256, host in clear, the URL sealed (`file-ingest-source|<id>`). */
    sourceUrlSha256: text(),
    sourceHost: text(),
    sourceUrlCiphertext: text(),
    /** An import source's validators, recorded on its `file_sources` row once stored. */
    etag: text(),
    lastModified: text(),
    /** The file the ingest became. `SET NULL`: the row outlives a later delete of it. */
    fileId: text().references(() => files.id, { onDelete: 'set null' }),
    /** The owner already held these bytes: `file_id` is that file. */
    deduplicated: boolean().notNull().default(false),
    /** The registered reference's outcome (`created` | `exists` | `not_found`). */
    referenceResult: text(),
    errorCode: text(),
    errorMessage: text(),
    /** Fetch or verification attempts (a dead worker's lease expires and another retries). */
    attempts: integer().notNull().default(0),
    leaseOwner: text(),
    leaseExpiresAt: timestamptz(),
    /** An open ingest not finished by then is aborted (its staging object deleted). */
    expiresAt: timestamptz().notNull(),
    finishedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'file_ingests_owner_check',
      sql`(${t.kind} = 'application' and ${t.ownerApplicationId} is not null and ${t.ownerUserId} is null)
        or (${t.kind} = 'account' and ${t.ownerUserId} is not null and ${t.ownerApplicationId} is null)`,
    ),
    check(
      'file_ingests_source_check',
      sql`${t.source} in (${sql.raw(inList(FILE_INGEST_SOURCES))})`,
    ),
    check(
      'file_ingests_status_check',
      sql`${t.status} in (${sql.raw(inList(FILE_INGEST_STATUSES))})`,
    ),
    check('file_ingests_kind_check', sql`${t.kind} in (${sql.raw(inList(FILE_INGEST_KINDS))})`),
    check(
      'file_ingests_visibility_check',
      sql`${t.visibility} in (${sql.raw(inList(FILE_VISIBILITIES))})`,
    ),
    check(
      'file_ingests_recording_check',
      sql`${t.source} <> 'recording' or ${t.secretCiphertext} is not null`,
    ),
    check(
      'file_ingests_import_check',
      sql`${t.source} <> 'import' or (${t.sourceUrlSha256} is not null and ${t.sourceHost} is not null and ${t.sourceUrlCiphertext} is not null)`,
    ),
    check('file_ingests_max_bytes_check', sql`${t.maxBytes} > 0`),
    check('file_ingests_size_check', sql`${t.size} is null or ${t.size} >= 0`),
    check('file_ingests_sha256_check', sql`${t.sha256} is null or ${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'file_ingests_completed_check',
      sql`${t.status} <> 'completed' or (${t.finishedAt} is not null and ${t.fileId} is not null)`,
    ),
    // The worker: ingests to fetch or verify, and open ones past their deadline.
    index('file_ingests_open_status_idx')
      .on(t.status, t.expiresAt)
      .where(sql`${t.status} in (${sql.raw(inList(OPEN_FILE_INGEST_STATUSES))})`),
    // The expiry sweep's range predicate (`db/expiry.ts`).
    index('file_ingests_finished_at_idx').on(t.finishedAt),
    index('file_ingests_file_id_idx').on(t.fileId),
  ],
);

export type FileIngestRow = typeof fileIngests.$inferSelect;
