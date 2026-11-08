/**
 * `device_credentials` — one HOLDER's zero-cookie credential for a device.
 *
 * A holder is whatever stores a `deviceSecret` and presents it at
 * `POST /session/device/token`: `auth.oxy.so`, and every official web app that
 * joined the browser's device through `/oauth/authorize` + `/oauth/token`
 * (mention.earth, alia.onl, …), or a native app group. ADR 0029 D2: every
 * official web app shares ONE browser DeviceSession, so one device has many
 * holders, each on its own origin with its own storage.
 *
 * ## Why a row per holder, not one column on `device_sessions`
 *
 * The device used to carry ONE `secret_hash` that every sign-in rotated, with a
 * 60-second grace for the one it replaced. With several holders that is a
 * lock-out machine: every app that joined the device rotated the secret out
 * from under every earlier holder, which then failed `invalid_device_secret` a
 * minute later. Holders cannot share one value either — they live on different
 * origins and cannot read each other's storage.
 *
 * So each sign-in ADDS a row and nothing rotates. The mint resolves any live
 * row of the device and echoes the presented secret back as
 * `nextDeviceSecret`. Rows are removed only when the device ends with nobody
 * signed in (or on sign-out-all), and by the per-device cap in
 * `deviceSession.service.ts` so abandoned holders cannot accumulate forever.
 *
 * `secret_hash` is `sha256(deviceSecret)` — a verifier, not a credential: a
 * dump of this table cannot forge a mint. UNIQUE, so one secret can never
 * address two devices, and it is also the lookup index. A credential is not
 * account-scoped: it proves "this browser", and the browser is signed in to
 * whichever accounts its DeviceSession holds.
 *
 * ## Platform credentials (ADR 0058)
 *
 * `platform` and `platform_application_id` are set together, on the credential
 * a platform that holds the Oxy session (OxyOS's `oxyos-accountd`, Astro) got
 * from its own sign-in naming its application (`platformClient`). Only such a
 * credential mints an application's token (`POST /session/device/app-token`),
 * and an application token names it in its `host` claim, so deleting it ends
 * every application token minted under it. The per-device cap never evicts it,
 * and the browser bridge never issues one.
 *
 * `platform_application_id` CASCADE: the platform's own application. It is
 * soft-deleted, so this fires only when its owning account is erased, and a
 * platform credential of an application that no longer exists proves nothing.
 *
 * ## Pending platform credentials (ADR 0058 R8)
 *
 * A platform client that confirms (`platformClient.confirms`) receives its
 * credential PENDING: `pending_until` set, ten minutes after the QR's claim
 * (`POST /session/device/platform`) or after the sign-in (the password and
 * second-factor routes). A pending credential proves nothing and mints nothing:
 * every lookup but `POST /session/device/platform/confirm` excludes it, and
 * once `pending_until` passes it is gone (lookups treat it as absent and the
 * expiry sweep deletes it, signing out a device it leaves without a live
 * credential: `sweepUnconfirmedPlatformCredentials`). Confirming it clears
 * `pending_until`, and deletes the credential it replaces
 * (`replaces_credential_id`, the one the sign-in's device proof presented) in
 * the same transaction: a lost answer leaves the old credential working, never
 * a new one nobody holds.
 */

import { sql } from 'drizzle-orm';
import { type AnyPgColumn, check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxy.so/db';
import { applications } from './applications';
import { deviceSessions } from './deviceSessions';

/**
 * How often unconfirmed platform credentials are swept (R8): their lookups
 * already treat them as absent once expired, so this bounds only how long a
 * device nothing holds stays signed in past its QR's window.
 */
export const UNCONFIRMED_PLATFORM_CREDENTIAL_SWEEP_INTERVAL_MS = 60_000;

/** The platforms that hold the Oxy session (`@oxy.so/contracts` `PLATFORM_HOSTS`). */
export const DEVICE_CREDENTIAL_PLATFORMS = ['oxyos', 'astro'] as const;

export const deviceCredentials = pgTable(
  'device_credentials',
  {
    id: generatedId(),
    /** `CASCADE` — a credential for a device that no longer exists proves nothing. */
    deviceSessionId: text()
      .notNull()
      .references(() => deviceSessions.id, { onDelete: 'cascade' }),
    secretHash: text().notNull(),
    createdAt: createdAt(),
    /**
     * When a mint last presented this credential, written at most once per
     * hour. It orders the per-device cap: the rows evicted first are the
     * holders that stopped showing up.
     */
    lastUsedAt: timestamptz().notNull().defaultNow(),
    /** The platform holding this credential, or NULL for an ordinary holder. */
    platform: text({ enum: DEVICE_CREDENTIAL_PLATFORMS }),
    /** The platform's own application (its `platformHost` registry entry). */
    platformApplicationId: text().references(() => applications.id, { onDelete: 'cascade' }),
    /**
     * Set on a platform credential issued to a client that confirms (R8): it
     * proves nothing until confirmed, and is gone once this passes. NULL:
     * confirmed, or never pending.
     */
    pendingUntil: timestamptz(),
    /**
     * The credential a pending one replaces (the sign-in's device proof),
     * deleted when this one is confirmed. `SET NULL`: gone first, nothing to
     * retire.
     */
    replacesCredentialId: text().references((): AnyPgColumn => deviceCredentials.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    unique('device_credentials_secret_hash_key').on(t.secretHash),
    index('device_credentials_device_session_id_idx').on(t.deviceSessionId),
    index('device_credentials_platform_application_id_idx').on(t.platformApplicationId),
    check(
      'device_credentials_platform_check',
      sql`${t.platform} is null or ${t.platform} in ('oxyos', 'astro')`,
    ),
    check(
      'device_credentials_platform_application_check',
      sql`(${t.platform} is null) = (${t.platformApplicationId} is null)`,
    ),
    // The expiry sweep's scan, and confirm's lookup of what a credential replaces.
    index('device_credentials_pending_until_idx')
      .on(t.pendingUntil)
      .where(sql`${t.pendingUntil} is not null`),
    index('device_credentials_replaces_credential_id_idx')
      .on(t.replacesCredentialId)
      .where(sql`${t.replacesCredentialId} is not null`),
    // Only a platform credential is ever pending, and only a pending one replaces.
    check(
      'device_credentials_pending_check',
      sql`(${t.pendingUntil} is null or ${t.platform} is not null) and (${t.replacesCredentialId} is null or ${t.pendingUntil} is not null)`,
    ),
  ],
);
