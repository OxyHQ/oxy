/**
 * How an application is recognised (ADR 0045): the registry half of app
 * assertions.
 *
 * `application_recognition` holds one application's Android and iOS identity;
 * `application_web_origins` its exact `https://` web origins, one row each. Both
 * are written ONLY by Oxy staff, through the application administration lane
 * (`PUT /applications/:appId/recognition`, `requireStaff` + `app:update`), which
 * replaces the whole declaration in one transaction
 * (`services/applicationRecognition.service.ts`). `POST /apps/assertions` reads
 * them to decide whether a platform proof names this application.
 *
 * ## One identity, one application
 *
 * Recognition is how Oxy tells apps apart, so no identity may name two: an
 * origin is a PRIMARY KEY, an Android package and an iOS team + bundle are
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

export type ApplicationRecognitionRow = typeof applicationRecognition.$inferSelect;
