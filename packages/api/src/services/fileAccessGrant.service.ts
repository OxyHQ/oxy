/**
 * A person's consent for an application to read their file (ADR 0043 stage 4c,
 * `file_access_grants`). The decision itself is `applicationReadConsent` in
 * `fileReference.service.ts`, over the file aggregate; this module writes the
 * rows and answers the owner's "Apps with access" list.
 *
 * Every write here changes what a cached file record answers, so each one ends
 * with `fileCache.invalidate` (cross-task, ADR 0043 stage 4b) — which also drops
 * every task's cached play sessions of the file, so a revocation stops a play
 * mid-stream.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { applications, fileAccessGrants } from '../db/schema';
import type { FileRecord } from '../types/file.types';
import fileCache from '../utils/fileCache';
import { stripSensitiveUrlQueryParams } from '../utils/sanitizeUrl';
import { revokePlaySessionsForFileApplication } from './playSession.service';

/**
 * Record that application `applicationId` stored `fileId` for its owner — a
 * person's upload, import, large upload or recording made with the act-as
 * authority of `/assets/service/user-media` — so it may read it back. A
 * revocation already on record is NOT undone: the person's decision stands
 * over a re-upload of the same bytes. Idempotent.
 */
export async function grantUploadAccess(
  fileId: string,
  applicationId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const inserted = await db
    .insert(fileAccessGrants)
    .values({ fileId, applicationId, state: 'granted', source: 'upload' })
    .onConflictDoNothing({ target: [fileAccessGrants.fileId, fileAccessGrants.applicationId] })
    .returning({ id: fileAccessGrants.id });
  if (inserted.length > 0) fileCache.invalidate(fileId);
}

/**
 * The owner attached their file to `applicationId` again (`POST
 * /assets/:id/links`): an explicit consent, which lifts an earlier revocation.
 * Without one on record nothing is written — the owner-made reference is the
 * consent (ADR 0021).
 */
export async function restoreAccessByOwner(
  fileId: string,
  applicationId: string,
  ownerUserId: string,
): Promise<boolean> {
  const restored = await getDb()
    .update(fileAccessGrants)
    .set({ state: 'granted', source: 'owner', changedByUserId: ownerUserId, revokedAt: null })
    .where(
      and(
        eq(fileAccessGrants.fileId, fileId),
        eq(fileAccessGrants.applicationId, applicationId),
        eq(fileAccessGrants.state, 'revoked'),
      ),
    )
    .returning({ id: fileAccessGrants.id });
  if (restored.length > 0) fileCache.invalidate(fileId);
  return restored.length > 0;
}

/**
 * The owner withdraws `applicationId`'s access to their file: whatever gave
 * it (an upload's grant, an owner-made reference), the application can no
 * longer read the file, and every play session it holds for the file ends now.
 * Sticky until the owner attaches the file to it again. Idempotent.
 */
export async function revokeApplicationAccess(
  fileId: string,
  applicationId: string,
  ownerUserId: string,
): Promise<{ streamsRevoked: number }> {
  await getDb()
    .insert(fileAccessGrants)
    .values({
      fileId,
      applicationId,
      state: 'revoked',
      source: 'owner',
      changedByUserId: ownerUserId,
      revokedAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: [fileAccessGrants.fileId, fileAccessGrants.applicationId],
      set: {
        state: 'revoked',
        source: 'owner',
        changedByUserId: ownerUserId,
        revokedAt: sql`coalesce(${fileAccessGrants.revokedAt}, now())`,
      },
    });
  const streamsRevoked = await revokePlaySessionsForFileApplication(fileId, applicationId, 'owner');
  // After both commits: every task drops the file's record and its sessions.
  fileCache.invalidate(fileId);
  return { streamsRevoked };
}

/** One application that can currently read a person's file, for its owner. */
export interface FileApplicationAccess {
  applicationId: string;
  name: string;
  /** The application's logo (an asset id or URL), as the store shows it. */
  icon: string | null;
  /** `upload`: it stored the file for the person; `link`: the person attached the file to it. */
  via: Array<'upload' | 'link'>;
  /** Since when (the earliest of those). */
  since: Date;
}

/**
 * Every application that can read `file` through a service token right now,
 * for its owner's "Apps with access": an application holding a `granted` row,
 * and one the owner attached the file to — less any the owner revoked. An
 * application's own file and a namespace's answer an empty list.
 */
export async function listApplicationAccess(file: FileRecord): Promise<FileApplicationAccess[]> {
  if (!file.ownerUserId) return [];
  const revoked = new Set(
    file.accessGrants.filter((row) => row.state === 'revoked').map((row) => row.applicationId),
  );
  const found = new Map<string, { via: Set<'upload' | 'link'>; since: Date }>();
  const note = (applicationId: string, via: 'upload' | 'link', since: Date) => {
    if (revoked.has(applicationId)) return;
    const entry = found.get(applicationId);
    if (!entry) {
      found.set(applicationId, { via: new Set([via]), since });
      return;
    }
    entry.via.add(via);
    if (since < entry.since) entry.since = since;
  };
  for (const row of file.accessGrants) {
    if (row.state === 'granted') {
      note(row.applicationId, row.source === 'upload' ? 'upload' : 'link', row.updatedAt);
    }
  }
  for (const link of file.links) {
    if (link.createdByUserId === file.ownerUserId) {
      note(link.applicationId, 'link', link.createdAt);
    }
  }
  if (found.size === 0) return [];

  const rows = await getDb()
    .select({ id: applications.id, name: applications.name, icon: applications.icon })
    .from(applications)
    .where(
      and(inArray(applications.id, [...found.keys()]), sql`${applications.status} <> 'deleted'`),
    );
  return rows
    .map((application) => {
      const entry = found.get(application.id) as { via: Set<'upload' | 'link'>; since: Date };
      return {
        applicationId: application.id,
        name: application.name,
        icon: application.icon === null ? null : stripSensitiveUrlQueryParams(application.icon),
        via: [...entry.via].sort(),
        since: entry.since,
      };
    })
    .sort((a, b) => a.since.getTime() - b.since.getTime() || a.name.localeCompare(b.name));
}

/** Whether `applicationId` exists (any status but deleted) — the revoke route's 404. */
export async function applicationExists(applicationId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: applications.id })
    .from(applications)
    .where(and(eq(applications.id, applicationId), sql`${applications.status} <> 'deleted'`))
    .limit(1);
  return row !== undefined;
}
