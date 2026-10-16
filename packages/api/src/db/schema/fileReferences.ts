/**
 * `file_references` — one place an APPLICATION uses an asset (ADR 0041 D4).
 *
 * The successor of `file_links`, whose `app` column was free text any
 * signed-in person could fill with anything. A reference names a real
 * application instead, and says nothing else about the file: it never changes
 * the file's visibility (only the owner does) and it is not a grant of access
 * on its own.
 *
 * ## Who writes one
 *
 * - An application, with its service token (`POST /assets/service/references`,
 *   `files:references:write`): `application_id` is the token's `appId` and
 *   `created_by_user_id` is NULL — no person made it.
 * - A signed-in person, from inside an application, on a file they own
 *   (`POST /assets/:id/links`, the compatibility surface): the session's
 *   application is recorded, and the person in `created_by_user_id`.
 *
 * `created_by_user_id = files.owner_user_id` is still the whole of ADR 0021's
 * "the owner attached it to this application" — a service-made reference can
 * never satisfy it, because its creator is NULL.
 *
 * ## The unique key
 *
 * `(file_id, application_id, entity_type, entity_id)`: one application uses a
 * file for one entity once. The creator is deliberately not in the key, as it
 * was not in `file_links`'.
 */

import { index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId } from '@oxy.so/db';
import { applications } from './applications';
import { files } from './files';
import { users } from './users';

export const fileReferences = pgTable(
  'file_references',
  {
    id: generatedId(),
    /** A reference is meaningless without the asset it points at. */
    fileId: text()
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    /**
     * The application that uses the file. Never free text (ADR 0041 D4).
     *
     * `CASCADE`: a reference is the application's record of its own usage;
     * with the application row gone (an account's hard delete is the only
     * thing that removes one) so is its usage. ADR 0041 D8 removes them
     * explicitly when an application is deleted.
     */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** The entity class within that application, e.g. `place`, `message`. */
    entityType: text().notNull(),
    /** The entity's id IN THAT APPLICATION's database — see `deferredForeignKeys.ts`. */
    entityId: text().notNull(),
    /**
     * The person who made the reference from inside the application, or NULL
     * when the application made it with its own service token.
     *
     * `SET NULL`: the reference is the APPLICATION's usage, and the person who
     * happened to create it is attribution only. When that person is the
     * file's owner, deleting them deletes the file and the reference with it.
     */
    createdByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    /**
     * DEPRECATED (ADR 0041 D9): a per-reference webhook, carried over from
     * `file_links`. Since stage 3 nothing reads or writes it — file events go
     * to the application's own verified endpoint
     * (`applications.files_webhook_url`). Dropped by a later post migration,
     * once no serving image reads it.
     */
    webhookUrl: text(),
    /** The ABSENCE of `updated_at` is the append-only contract. */
    createdAt: createdAt(),
  },
  (t) => [
    unique('file_references_file_id_application_id_entity_key').on(
      t.fileId,
      t.applicationId,
      t.entityType,
      t.entityId,
    ),
    // "Everything this application uses for this entity" — the reconcile and
    // removal lookups lead with the application.
    index('file_references_application_id_entity_type_entity_id_idx').on(
      t.applicationId,
      t.entityType,
      t.entityId,
    ),
    // "Everything this person referenced" (account deletion SET NULL probe).
    index('file_references_created_by_user_id_idx').on(t.createdByUserId),
    // Listing one file's references needs no index of its own — the unique
    // above leads with `file_id`.
  ],
);
