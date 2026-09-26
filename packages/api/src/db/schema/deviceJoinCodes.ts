/**
 * `device_join_codes` — the one-use codes the browser bridge hands an official
 * app so it can join the browser's DeviceSession (ADR 0029 D2).
 *
 * Different domains share no storage, so the only place a browser's Oxy session
 * can live is auth.oxy.so. The first time a person presses sign-in in an app that
 * holds no device credential, the app opens `auth.oxy.so/bridge` from that press.
 * The bridge proves auth.oxy.so's own credential (`POST /session/device/join-code`)
 * and posts the code this table records to the app's window; the app redeems it
 * (`POST /session/device/join`) with the PKCE verifier only it holds and receives
 * its OWN holder credential for the same device.
 *
 * A code is:
 * - one-use (`used_at`, claimed by one conditional update);
 * - short (`expires_at`, about a minute — the bridge window closes in well under
 *   a second);
 * - bound to one OFFICIAL application and to one of its exact registered redirect
 *   URIs, which is also the only origin the bridge posts it to;
 * - bound to the app's PKCE S256 challenge, so a code read in transit is useless.
 *
 * `code_hash` is `sha256(code)`: the code is a bearer credential and is never
 * stored.
 */

import { index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxy.so/db';
import { applications } from './applications';
import { deviceSessions } from './deviceSessions';

export const deviceJoinCodes = pgTable(
  'device_join_codes',
  {
    id: generatedId(),
    codeHash: text().notNull(),
    /** `CASCADE` — a code for a device that no longer exists joins nothing. */
    deviceSessionId: text()
      .notNull()
      .references(() => deviceSessions.id, { onDelete: 'cascade' }),
    /** The official application the code is issued TO. */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** Bound at issue time, re-checked (exactly) at redemption. */
    redirectUri: text().notNull(),
    /** PKCE S256 challenge — always present: the redeemer is a public client. */
    codeChallenge: text().notNull(),
    expiresAt: timestamptz().notNull(),
    /** Set by the atomic single-use claim; a set value is a replay, not a miss. */
    usedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('device_join_codes_code_hash_key').on(t.codeHash),
    index('device_join_codes_device_session_id_idx').on(t.deviceSessionId),
    index('device_join_codes_application_id_idx').on(t.applicationId),
    // Supports the expiry sweep in `db/expiry.ts`.
    index('device_join_codes_expires_at_idx').on(t.expiresAt),
  ],
);
