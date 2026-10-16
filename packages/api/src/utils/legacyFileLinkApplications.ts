/**
 * The free-text `file_links.app` values in use, and the application each one
 * names (ADR 0043 D4).
 *
 * `file_references` names a real application; `file_links` named a string. This
 * is the one mapping between them, used three ways that must agree:
 *
 * 1. migration `0168_file_references` — its `VALUES` list is this table,
 *    spelled out (`legacyFileLinkApplications.test.ts` asserts the two match);
 * 2. `scripts/file-references-preflight.ts` — lists every distinct `app` in a
 *    database and what it resolves to, so an operator can see BEFORE deploying
 *    whether the migration will refuse;
 * 3. `POST /assets/:id/links` — the session compatibility surface, where a
 *    shared first-party session cannot say which application it is and the
 *    body's `app` string is all there is.
 *
 * The values were inventoried across every Oxy repository on 2026-10-16:
 * `goway` (GoWay's place gallery), `mercaria` (review media, digital asset
 * files), `oxy-mail` (this API's mail attachments) and `profiles` (the SDK's
 * `uploadAvatar` default). `nilo` is listed because Nilo is the other product
 * the ADR names as registering usage. Nothing passed an application id, but an
 * `app` that IS an application's id resolves to that application too.
 *
 * Resolution, in the migration and at runtime alike: the active application
 * whose id is `applicationId`, or a non-`third_party` active application whose
 * name is one of `names`. Exactly one must match; none, or two, is a refusal —
 * never a silent drop and never a guess.
 *
 * Data only: no database, no side effects. The pre-flight script imports it
 * before anything else is configured.
 */

import { INBOX_APPLICATION_ID } from '../config/inboxInference';
import { GOWAY_APPLICATION_ID, NILO_APPLICATION_ID } from '../scripts/seedOxyApplicationsSpecs';

export interface LegacyFileLinkApplication {
  /** The `file_links.app` / request-body `app` string. */
  readonly app: string;
  /** The application's id, when its seed pins one (identical in every environment). */
  readonly applicationId: string | null;
  /** The seed names the application has carried, current first. */
  readonly names: readonly string[];
}

export const LEGACY_FILE_LINK_APPLICATIONS: readonly LegacyFileLinkApplication[] = [
  { app: 'goway', applicationId: GOWAY_APPLICATION_ID, names: ['GoWay'] },
  { app: 'mercaria', applicationId: null, names: ['Mercaria', 'Marketplace'] },
  { app: 'nilo', applicationId: NILO_APPLICATION_ID, names: ['Nilo'] },
  { app: 'oxy-mail', applicationId: INBOX_APPLICATION_ID, names: ['Oxy Inbox'] },
  { app: 'profiles', applicationId: null, names: ['Oxy Accounts'] },
];

/** The entry for `app`, or `undefined` when it is not a legacy alias. */
export function legacyFileLinkApplication(app: string): LegacyFileLinkApplication | undefined {
  return LEGACY_FILE_LINK_APPLICATIONS.find((entry) => entry.app === app);
}
