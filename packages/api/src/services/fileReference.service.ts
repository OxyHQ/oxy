/**
 * Who may reference a file, and which application a request names (ADR 0043 D4).
 *
 * The persistence is `fileRepository.ts` (`insertFileReference`,
 * `deleteFileReference`) and the lifecycle is `assetService.linkFile` /
 * `unlinkFile`; this module holds the two decisions the routes share.
 */

import { and, eq, inArray, ne, or, type SQL } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { applications } from '../db/schema';
import type { FileRecord } from '../types/file.types';
import { legacyFileLinkApplication } from '../utils/legacyFileLinkApplications';

/** An application an `app` string could name. */
export interface ReferenceApplicationCandidate {
  id: string;
  name: string;
  type: string;
}

/**
 * Every active application an `app` string names — the shared half of
 * {@link resolveReferenceApplicationId} and `scripts/file-references-preflight.ts`,
 * which reports the candidates when there is not exactly one.
 *
 * An active application whose id IS `app`; or, for a legacy alias
 * (`utils/legacyFileLinkApplications.ts`), the active application its seed pins
 * by id, or a non-`third_party` active application carrying one of its seed
 * names. Bounded: two already decide "ambiguous", a few more help an operator.
 */
export async function referenceApplicationCandidates(
  app: string,
  limit = 5,
): Promise<ReferenceApplicationCandidate[]> {
  const legacy = legacyFileLinkApplication(app);
  const matches: SQL[] = [eq(applications.id, app)];
  if (legacy?.applicationId) matches.push(eq(applications.id, legacy.applicationId));
  if (legacy && legacy.names.length > 0) {
    const named = and(
      ne(applications.type, 'third_party'),
      inArray(applications.name, [...legacy.names]),
    );
    if (named) matches.push(named);
  }
  return getDb()
    .selectDistinct({ id: applications.id, name: applications.name, type: applications.type })
    .from(applications)
    .where(and(eq(applications.status, 'active'), or(...matches)))
    .orderBy(applications.id)
    .limit(limit);
}

/**
 * The application an `app` string names, or `null` when it names none or more
 * than one — the runtime twin of migration 0171's `oxy_file_link_application_id`
 * (`utils/legacyFileLinkApplications.ts` is the table both read).
 */
export async function resolveReferenceApplicationId(app: string): Promise<string | null> {
  const candidates = await referenceApplicationCandidates(app, 2);
  return candidates.length === 1 ? candidates[0].id : null;
}

/**
 * True when the file's own OWNER attached it to `appId` — ADR 0021's grant.
 *
 * `created_by_user_id = owner_user_id` is not attacker-supplied: the session
 * route writes the caller's own id and admits only the file's owner, and a
 * service-made reference has a NULL creator, which equals nothing.
 */
export function isOwnerReferencedToApp(file: FileRecord, appId: string): boolean {
  if (!file.ownerUserId) return false;
  return file.links.some(
    (link) => link.applicationId === appId && link.createdByUserId === file.ownerUserId,
  );
}

/** How an application came to be able to read a person's file (ADR 0043 stage 4c). */
export type ApplicationReadConsent = 'owner' | 'upload' | 'link';

/**
 * Why application `appId` may read `file` with its service token, or `null`
 * when it may not (ADR 0043 stage 4c) — the whole authorization of
 * `/service/linked-url` and of a play session:
 *
 * - `owner`: the application's OWN file;
 * - for a person's file, the person's consent (`file_access_grants`): a
 *   `revoked` row refuses whatever else holds; a `granted` row admits
 *   (`upload` — the application stored the file for the person — or a
 *   re-consent by the person); with no row, a reference the OWNER made to
 *   this application ({@link isOwnerReferencedToApp}) admits (`link`).
 *
 * A platform namespace's file and another application's file are never
 * readable this way. Status is the caller's business (only `active` is served).
 */
export function applicationReadConsent(
  file: FileRecord,
  appId: string,
): ApplicationReadConsent | null {
  if (file.ownerApplicationId) return file.ownerApplicationId === appId ? 'owner' : null;
  if (!file.ownerUserId) return null;
  const grant = file.accessGrants.find((row) => row.applicationId === appId);
  if (grant) {
    if (grant.state !== 'granted') return null;
    return grant.source === 'upload' ? 'upload' : 'link';
  }
  return isOwnerReferencedToApp(file, appId) ? 'link' : null;
}

/** Whether application `appId` may read `file`'s bytes ({@link applicationReadConsent}). */
export function mayApplicationRead(file: FileRecord, appId: string): boolean {
  return applicationReadConsent(file, appId) !== null;
}

/**
 * Whether application `appId` may reference `file` with its service token
 * (ADR 0043 D4):
 *
 * - its OWN file, live (a trashed one comes back to `active`);
 * - any owner's `public` or `unlisted` file that is `active` — whoever has the
 *   link can read it anyway;
 * - an account's `active` private file this application may read
 *   ({@link mayApplicationRead}: it stored it for the person, or the person
 *   attached it to it — never after the person revoked it).
 *
 * Never another application's private file, never a trashed or deleted file it
 * does not own. A refusal answers exactly like a missing file.
 */
export function mayApplicationReference(file: FileRecord, appId: string): boolean {
  if (file.status === 'deleted') return false;
  if (file.ownerApplicationId === appId) return true;
  if (file.status !== 'active') return false;
  if (file.visibility !== 'private') return true;
  if (file.ownerApplicationId) return false;
  return mayApplicationRead(file, appId);
}
