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
 */

import { index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxy.so/db';
import { deviceSessions } from './deviceSessions';

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
  },
  (t) => [
    unique('device_credentials_secret_hash_key').on(t.secretHash),
    index('device_credentials_device_session_id_idx').on(t.deviceSessionId),
  ],
);
