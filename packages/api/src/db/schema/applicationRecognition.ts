/**
 * How an application is recognised (ADR 0045): the registry half of app
 * assertions.
 *
 * `application_recognition` holds one application's Android and iOS identity,
 * and (ADR 0058) whether the application is a platform that holds the Oxy
 * session (`platform_host`); `application_web_origins` its exact `https://` web
 * origins, one row each; `application_oxyos_entries` the OxyOS desktop entry
 * ids that launch it, one row each. All
 * are written ONLY by Oxy staff, through the application administration lane
 * (`PUT /applications/:appId/recognition`, `requireStaff` + `app:update`), which
 * replaces the whole declaration in one transaction
 * (`services/applicationRecognition.service.ts`). `POST /apps/assertions` reads
 * them to decide whether a platform proof names this application.
 *
 * ## One identity, one application
 *
 * Recognition is how Oxy tells apps apart, so no identity may name two: an
 * origin and a desktop entry id are PRIMARY KEYs, an Android package and an iOS team + bundle are
 * UNIQUE. Postgres treats NULLs as distinct, so applications that declare no
 * Android or iOS identity do not collide.
 *
 * ## `ON DELETE`
 *
 * - `application_id` CASCADE: applications are soft-deleted, so this fires only
 *   when the owning account is erased; the declaration means nothing without it.
 *   An origin cascades from its declaration.
 * - `updated_by_user_id` SET NULL: attribution, which an erasure must not turn
 *   into the loss of the declaration it attributes.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from '@oxy.so/db';
import { applications } from './applications';
import { users } from './users';

export const applicationRecognition = pgTable(
  'application_recognition',
  {
    applicationId: text()
      .primaryKey()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** The Android application id (`earth.mention.app`), or NULL when the app declares no Android build. */
    androidPackageName: text(),
    /** Lowercase hex SHA-256 digests of the signing certificates Play reports for it. */
    androidSigningCertSha256: text().array().notNull().default(sql`'{}'::text[]`),
    /** The Apple Developer team id, or NULL when the app declares no iOS build. */
    iosTeamId: text(),
    iosBundleId: text(),
    /**
     * `oxyos` or `astro` when this application IS a platform that holds the Oxy
     * session (ADR 0058): its public client id is the one the platform's own
     * sign-in names. NULL for every other application.
     */
    platformHost: text({ enum: ['oxyos', 'astro'] }),
    /** The staff member who last wrote the declaration. */
    updatedByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('application_recognition_android_package_name_key').on(t.androidPackageName),
    uniqueIndex('application_recognition_ios_app_key').on(t.iosTeamId, t.iosBundleId),
    // A package without a certificate could never be recognised, and a
    // certificate without a package names nothing.
    check(
      'application_recognition_android_check',
      sql`(${t.androidPackageName} is null) = (cardinality(${t.androidSigningCertSha256}) = 0)`,
    ),
    check(
      'application_recognition_ios_check',
      sql`(${t.iosTeamId} is null) = (${t.iosBundleId} is null)`,
    ),
    check(
      'application_recognition_platform_host_check',
      sql`${t.platformHost} is null or ${t.platformHost} in ('oxyos', 'astro')`,
    ),
  ],
);

export const applicationWebOrigins = pgTable(
  'application_web_origins',
  {
    /** An exact origin as a browser sends it in `Origin` (`https://mention.earth`). */
    origin: text().primaryKey(),
    applicationId: text()
      .notNull()
      .references(() => applicationRecognition.applicationId, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('application_web_origins_application_id_idx').on(t.applicationId),
    check('application_web_origins_origin_check', sql`${t.origin} ~ '^https://[^/?#@]+$'`),
  ],
);

/**
 * The OxyOS desktop entry ids that launch an application (ADR 0058): what
 * `oxyos-accountd` attests when it asks for that application's token. One id
 * names one application, as an origin does.
 */
export const applicationOxyosEntries = pgTable(
  'application_oxyos_entries',
  {
    /** The reverse-DNS id OxyOS launches the application by (`so.oxy.dropsea`). */
    desktopEntryId: text().primaryKey(),
    applicationId: text()
      .notNull()
      .references(() => applicationRecognition.applicationId, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('application_oxyos_entries_application_id_idx').on(t.applicationId),
    check(
      'application_oxyos_entries_desktop_entry_id_check',
      sql`${t.desktopEntryId} ~ '^[a-z0-9]+([.][a-z0-9-]+)+$' and length(${t.desktopEntryId}) <= 255`,
    ),
  ],
);

export type ApplicationRecognitionRow = typeof applicationRecognition.$inferSelect;
