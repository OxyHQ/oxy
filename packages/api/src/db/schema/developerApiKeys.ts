/**
 * `developer_api_keys` — a long-lived API key issued against an application.
 *
 * Ported from `models/DeveloperApiKey.ts`.
 *
 * **Deletion candidate, NOT dropped here.** No route or service in this package
 * reads or writes this model any more; its only remaining reference is
 * `ApiKeyUsage.apiKeyId`. The contract permits dropping a collection only once
 * it is CONFIRMED empty in production, which cannot be checked from here, so it
 * travels and the finding is reported instead of acted on.
 *
 * `generateKey` / `hashKey` / `validateKey` were Mongoose statics and an
 * instance method — application code with no schema counterpart. They belong in
 * a plain module at the call-site port; nothing about them is expressible here,
 * and `key_hash` being the only stored form is what this table already says.
 *
 * `appId` is renamed `application_id`, matching every other table that
 * references `applications`. Free to do: nothing serializes this model, so no
 * wire contract observes the name.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import type { ApplicationScope } from '../../utils/applicationScopes';
import { applications } from './applications';
import { createdAt, generatedId, textArrayLiteral, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';

/**
 * What a developer API key may be used for — a NARROWER vocabulary than
 * `APPLICATION_SCOPES`.
 *
 * `satisfies readonly ApplicationScope[]` proves every value is a real
 * application scope, so a typo here fails `tsc` rather than producing a key that
 * can never be authorised. The tuple itself is copied rather than imported
 * because the model pulls in mongoose; `__tests__/applications.test.ts` holds
 * the two equal.
 */
export const DEVELOPER_API_KEY_SCOPES = [
  'chat:completions',
  'models:read',
  'files:read',
  'files:write',
  'files:delete',
  'user:read',
  'webhooks:receive',
] as const satisfies readonly ApplicationScope[];

/** Scopes a key gets when the caller names none. */
export const DEFAULT_DEVELOPER_API_KEY_SCOPES = ['chat:completions', 'models:read'] as const;

/** Requests per day a key gets by default. `NULL` in any limit column means "unlimited". */
const DEFAULT_REQUESTS_PER_DAY = 1000;

export const developerApiKeys = pgTable(
  'developer_api_keys',
  {
    id: generatedId(),
    /**
     * The developer the key belongs to. `CASCADE` — a deleted account's key must
     * stop authenticating.
     *
     * Mongoose typed this as a bare `String` with no `ref`, so nothing checked
     * it; the values are `User._id` strings and this is a real relation the port
     * gets to enforce.
     */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `CASCADE` — a key scoped to an application that no longer exists grants nothing. */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /** SHA-256 of the key. The plaintext is shown once and never stored. */
    keyHash: text().notNull(),
    /** Leading characters of the key, for display in a key list. */
    keyPrefix: text().notNull(),
    scopes: text()
      .array()
      .notNull()
      .default([...DEFAULT_DEVELOPER_API_KEY_SCOPES]),
    /** NULL means "never expires" — Mongoose's `default: null` says the same. */
    expiresAt: timestamptz(),
    lastUsedAt: timestamptz(),
    isActive: boolean().notNull().default(true),

    // ---- rate limits (flattened; NULL means unlimited) ---------------------
    // A nested object with four known numeric fields is four columns, not
    // `jsonb`: NULL already carries the "no limit" meaning the model relied on,
    // and a limit is a value a query may one day filter or aggregate on.
    rateLimitRequestsPerMinute: integer(),
    rateLimitRequestsPerDay: integer().default(DEFAULT_REQUESTS_PER_DAY),
    rateLimitTokensPerMinute: integer(),
    rateLimitTokensPerDay: integer(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('developer_api_keys_key_hash_key').on(t.keyHash),
    // "This developer's live keys" / "this application's live keys". Mongo's
    // standalone `{userId}` and `{appId}` are dropped: a btree serves any
    // leading prefix, and these two already lead with those columns — which is
    // also what lets Postgres cascade a user or application delete without a
    // sequential scan.
    index('developer_api_keys_user_id_is_active_idx').on(t.userId, t.isActive),
    index('developer_api_keys_application_id_is_active_idx').on(t.applicationId, t.isActive),
    check(
      'developer_api_keys_scopes_check',
      sql`${t.scopes} <@ ${sql.raw(textArrayLiteral(DEVELOPER_API_KEY_SCOPES))}`
    ),
    // A limit is a rate, so zero or negative is not a stricter limit — it is a
    // key that can never be used, which no write path intends.
    check(
      'developer_api_keys_rate_limit_check',
      sql`(${t.rateLimitRequestsPerMinute} is null or ${t.rateLimitRequestsPerMinute} > 0)
        and (${t.rateLimitRequestsPerDay} is null or ${t.rateLimitRequestsPerDay} > 0)
        and (${t.rateLimitTokensPerMinute} is null or ${t.rateLimitTokensPerMinute} > 0)
        and (${t.rateLimitTokensPerDay} is null or ${t.rateLimitTokensPerDay} > 0)`
    ),
  ]
);
