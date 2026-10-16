/**
 * File events to applications (ADR 0043 D9): what is written, and how it is
 * signed.
 *
 * {@link recordFileEvents} is called INSIDE the transaction that changed the
 * files — the tombstone of every delete (`assetService.tombstoneAndOwePurge`),
 * a visibility change, a move to or out of trash — and writes one
 * `file_event_deliveries` row per (file, application) for every application
 * that holds a reference to the file and for the application that owns it,
 * when that application has a VERIFIED file-events endpoint. The change and
 * its events commit or roll back together. `fileEventDelivery.worker.ts` sends
 * them.
 *
 * Each application sees only its OWN references in the payload: another
 * product's use of the same file is never disclosed, and an account-owned
 * file's owner is never named.
 *
 * ## The signature
 *
 * `oxy-signature: t=<unix seconds>,v1=<hex>` where `<hex>` is
 * HMAC-SHA256(secret, `<t>.<raw body>`). The receiver recomputes it over the
 * exact bytes it received and refuses a `t` outside its replay window;
 * `verifyFileEventSignature` in `@oxy.so/core/server` does both.
 */

import crypto from 'node:crypto';
import { and, inArray, isNotNull, ne } from 'drizzle-orm';
import type { Transaction } from '../config/postgres';
import { applications } from '../db/schema/applications';
import { fileEventDeliveries, type FileEventType } from '../db/schema/fileEventDeliveries';
import { fileReferences } from '../db/schema/fileReferences';
import { files } from '../db/schema/files';
import { openSecret, sealSecret } from '../utils/secretBox';

/** Rows per insert: an application's deletion emits for every file it owned. */
const CHUNK_SIZE = 500;

/** Who owns the file, as an event says it — never which account. */
export type FileEventOwnerKind = 'account' | 'application' | 'platform';

/** The JSON body of one file event, exactly as POSTed. */
export interface FileEventPayload {
  id: string;
  type: FileEventType;
  occurredAt: string;
  file: {
    id: string;
    ownerKind: FileEventOwnerKind;
    visibility: string;
    status: string;
  };
  /** The RECIPIENT application's own references to the file (possibly none: it owns the file). */
  references: Array<{ entityType: string; entityId: string }>;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function ownerKind(row: {
  ownerUserId: string | null;
  ownerApplicationId: string | null;
}): FileEventOwnerKind {
  if (row.ownerUserId) return 'account';
  if (row.ownerApplicationId) return 'application';
  return 'platform';
}

/**
 * Queue `type` for every application told about each of `fileIds`, inside the
 * caller's transaction, reading the files AS THEY NOW STAND in it (so the
 * payload carries the new status/visibility). Returns the rows written.
 *
 * Recipients: the owning application and every application holding a
 * reference — each once per file — that is not deleted and has a verified
 * endpoint. Nobody else gets a row, so an application without an endpoint
 * costs the outbox nothing.
 */
export async function recordFileEvents(
  tx: Transaction,
  type: FileEventType,
  fileIds: readonly string[],
  options: {
    occurredAt?: Date;
    /**
     * The status the payload states instead of the row's: for files whose rows
     * the same transaction REMOVES rather than tombstones (an account's
     * deletion or archive), read here while they still stand.
     */
    status?: (typeof files.$inferSelect)['status'];
  } = {},
): Promise<number> {
  const ids = [...new Set(fileIds)];
  if (ids.length === 0) return 0;
  const occurredAt = options.occurredAt ?? new Date();
  let written = 0;

  for (const part of chunks(ids, CHUNK_SIZE)) {
    const rows = await tx
      .select({
        id: files.id,
        ownerUserId: files.ownerUserId,
        ownerApplicationId: files.ownerApplicationId,
        visibility: files.visibility,
        status: files.status,
      })
      .from(files)
      .where(inArray(files.id, part));
    if (rows.length === 0) continue;

    const references = await tx
      .select({
        fileId: fileReferences.fileId,
        applicationId: fileReferences.applicationId,
        entityType: fileReferences.entityType,
        entityId: fileReferences.entityId,
      })
      .from(fileReferences)
      .where(inArray(fileReferences.fileId, part));

    const candidates = new Set<string>();
    for (const row of rows) if (row.ownerApplicationId) candidates.add(row.ownerApplicationId);
    for (const reference of references) candidates.add(reference.applicationId);
    if (candidates.size === 0) continue;

    const subscribed = new Set(
      (
        await tx
          .select({ id: applications.id })
          .from(applications)
          .where(
            and(
              inArray(applications.id, [...candidates]),
              ne(applications.status, 'deleted'),
              isNotNull(applications.filesWebhookUrl),
              isNotNull(applications.filesWebhookVerifiedAt),
            ),
          )
      ).map((application) => application.id),
    );
    if (subscribed.size === 0) continue;

    const byFile = new Map<string, typeof references>();
    for (const reference of references) {
      const bucket = byFile.get(reference.fileId);
      if (bucket) bucket.push(reference);
      else byFile.set(reference.fileId, [reference]);
    }

    const values: (typeof fileEventDeliveries.$inferInsert)[] = [];
    for (const row of rows) {
      const fileReferencesOfRow = byFile.get(row.id) ?? [];
      const recipients = new Set<string>();
      if (row.ownerApplicationId) recipients.add(row.ownerApplicationId);
      for (const reference of fileReferencesOfRow) recipients.add(reference.applicationId);

      const eventId = crypto.randomUUID();
      for (const applicationId of recipients) {
        if (!subscribed.has(applicationId)) continue;
        const payload: FileEventPayload = {
          id: eventId,
          type,
          occurredAt: occurredAt.toISOString(),
          file: {
            id: row.id,
            ownerKind: ownerKind(row),
            visibility: row.visibility,
            status: options.status ?? row.status,
          },
          references: fileReferencesOfRow
            .filter((reference) => reference.applicationId === applicationId)
            .map(({ entityType, entityId }) => ({ entityType, entityId })),
        };
        values.push({
          eventId,
          applicationId,
          type,
          fileId: row.id,
          payload: payload as unknown as Record<string, unknown>,
          occurredAt,
        });
      }
    }

    for (const batch of chunks(values, CHUNK_SIZE)) {
      await tx.insert(fileEventDeliveries).values(batch);
      written += batch.length;
    }
  }
  return written;
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/** The header carrying the timestamp and signature. */
export const FILE_EVENT_SIGNATURE_HEADER = 'oxy-signature';

/** HMAC-SHA256 hex over `<timestamp>.<body>`. */
export function fileEventSignature(secret: string, timestamp: number, body: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** The value of {@link FILE_EVENT_SIGNATURE_HEADER} for `body` signed now (or at `at`). */
export function fileEventSignatureHeader(secret: string, body: string, at = new Date()): string {
  const timestamp = Math.floor(at.getTime() / 1000);
  return `t=${timestamp},v1=${fileEventSignature(secret, timestamp, body)}`;
}

/** A fresh signing secret, in the shape a developer recognises as one. */
export function newFileWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(32).toString('base64url')}`;
}

function secretContext(applicationId: string): string {
  return `files-webhook|${applicationId}`;
}

/** Seal a signing secret for `applications.files_webhook_secret_ciphertext`. */
export function sealFileWebhookSecret(applicationId: string, secret: string): string {
  return sealSecret(secret, secretContext(applicationId));
}

/** Open what {@link sealFileWebhookSecret} sealed for the same application. */
export function openFileWebhookSecret(applicationId: string, sealed: string): string {
  return openSecret(sealed, secretContext(applicationId));
}
