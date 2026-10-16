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
 * than one — the runtime twin of migration 0169's `oxy_file_link_application_id`
 * (`utils/legacyFileLinkApplications.ts` is the table both read).
 */
export async function resolveReferenceApplicationId(app: string): Promise<string | null> {
  const candidates = await referenceApplicationCandidates(app, 2);
  return candidates.length === 1 ? candidates[0].id : null;
}

/**
 * True when the file's own OWNER attached it to `appId` — ADR 0021's grant, and
 * the whole authorization of `/service/linked-url`.
 *
 * `created_by_user_id = owner_user_id` is not attacker-supplied: the session
 * route writes the caller's own id and admits only the file's owner, and a
 * service-made reference has a NULL creator, which equals nothing. An
 * application's OWN file needs no reference: the caller is its owner.
 */
export function isOwnerReferencedToApp(file: FileRecord, appId: string): boolean {
  if (file.ownerApplicationId) return file.ownerApplicationId === appId;
  if (!file.ownerUserId) return false;
  return file.links.some(
    (link) => link.applicationId === appId && link.createdByUserId === file.ownerUserId,
  );
}

/**
 * Whether application `appId` may reference `file` with its service token
 * (ADR 0043 D4):
 *
 * - its OWN file, live (a trashed one comes back to `active`);
 * - any owner's `public` or `unlisted` file that is `active` — whoever has the
 *   link can read it anyway;
 * - an account's `active` private file whose owner attached it to this
 *   application ({@link isOwnerReferencedToApp}).
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
  return isOwnerReferencedToApp(file, appId);
}
