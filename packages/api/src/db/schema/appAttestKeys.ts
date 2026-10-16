/**
 * `app_attest_keys` — App Attest keys Oxy has verified (ADR 0045).
 *
 * An iOS install of an application generates a key in the Secure Enclave, has
 * Apple attest it over an `attest_key` challenge, and registers it through
 * `POST /apps/attest-keys`. Every app assertion it then asks for is signed with
 * that key and checked against the public key and counter stored here; the
 * counter only moves forward, by a conditional UPDATE, so a replayed or raced
 * assertion is refused.
 *
 * A key belongs to the application install, not to a person: a different
 * person signing in on the same device uses the same key, and nothing here
 * says who registered it.
 *
 * ## Retention
 *
 * A key unused for {@link APP_ATTEST_KEY_RETENTION_SECONDS} is swept
 * (`db/expiry.ts`, on `last_used_at`). The install then attests a new one, which
 * the SDK does on `attest_key_unknown`.
 *
 * `application_id` CASCADE: the key proves nothing about an application that is gone.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, inList, timestamptz } from '@oxy.so/db';
import { applications } from './applications';

/** Where an App Attest key was attested: a store or TestFlight build, or a development build. */
export const APP_ATTEST_ENVIRONMENTS = ['production', 'development'] as const;
export type AppAttestEnvironment = (typeof APP_ATTEST_ENVIRONMENTS)[number];

/** 180 days. */
export const APP_ATTEST_KEY_RETENTION_SECONDS = 180 * 24 * 60 * 60;

export const appAttestKeys = pgTable(
  'app_attest_keys',
  {
    /** Apple's key id: the standard base64 of the SHA-256 of the public key. */
    keyId: text().primaryKey(),
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** SubjectPublicKeyInfo DER, base64. A public key: nothing here can sign. */
    publicKeySpki: text().notNull(),
    /** The highest counter Oxy has accepted. */
    signCount: bigint({ mode: 'number' }).notNull().default(0),
    environment: text({ enum: APP_ATTEST_ENVIRONMENTS }).notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamptz().notNull().default(sql`now()`),
  },
  (t) => [
    index('app_attest_keys_application_id_idx').on(t.applicationId),
    index('app_attest_keys_last_used_at_idx').on(t.lastUsedAt),
    check('app_attest_keys_key_id_check', sql`${t.keyId} ~ '^[A-Za-z0-9+/]{43}=$'`),
    check(
      'app_attest_keys_environment_check',
      sql`${t.environment} in (${sql.raw(inList(APP_ATTEST_ENVIRONMENTS))})`,
    ),
    check('app_attest_keys_sign_count_check', sql`${t.signCount} >= 0`),
  ],
);
