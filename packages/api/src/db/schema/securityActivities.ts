/**
 * `security_activities` — the account's own audit trail, as shown by
 * `GET /security/activity`.
 *
 * Ported from `models/SecurityActivity.ts`.
 *
 * ## No IP, anywhere — and none can be added back by accident
 *
 * `SecurityActivity.ipAddress` was REMOVED under the platform-wide no-user-IPs
 * -at-rest invariant (threat model: state-actor harassment). Raw, hashed and
 * geo-derived forms are all forbidden — a salted hash of the IPv4 space is
 * brute-forceable by anyone with server access. There is no IP column here and
 * none is to be added "for security"; that was a deliberate trade, not an
 * oversight. `user_agent` (a client string, not a network address) and
 * `device_id` are what remains, exactly as in the Mongo model.
 *
 * The one genuinely open surface is `metadata`, which is `Mixed` in Mongoose and
 * `jsonb` here: a writer could smuggle an address into it. That is a call-site
 * rule, not something a schema can state, and it is unchanged by this port.
 *
 * ## `timestamp` → `occurred_at`
 *
 * The Mongoose field is called `timestamp`. It is renamed for two reasons, the
 * second measured rather than reasoned:
 *
 * 1. It is the EVENT time (caller-supplied, defaulting to now), which is a
 *    different thing from `created_at`, the row's write time — and `timestamp`
 *    beside `created_at` and `updated_at` says nothing about which is which.
 * 2. `timestamp` is a SQL type name, so `pg_get_indexdef` renders an index on it
 *    as `btree ("timestamp")`, with quotes. The expiry gate in
 *    `db/__tests__/expiry.test.ts` matches `/\(<column>\b/` against `indexdef`
 *    to prove every swept column is indexed; against a quoted name that match
 *    fails and the gate goes red on a table that is correctly indexed.
 *    Verified against the real server, not inferred. A column name that breaks a
 *    gate is a bad column name.
 *
 * ## Expiry
 *
 * Mongo TTL `expireAfterSeconds: 730 * 24 * 60 * 60` on `timestamp` — a
 * two-year retention window measured from the EVENT, bounding growth while
 * keeping enough audit history. Registered in `db/expiry.ts` against
 * `occurred_at` with the same retention. Nothing reads this table with an
 * expiry predicate, and nothing needs to: the retention is about storage, not
 * about a row becoming unsafe to return.
 */

import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';

/**
 * The audit vocabulary, and the SINGLE declaration of it — the Mongoose model
 * that carried the other copy is gone. It renders the CHECK on `event_type`,
 * and `check-drizzle-snapshot-sync` holds that rendering against the migration
 * the database was actually built from.
 */
export const SECURITY_EVENT_TYPES = [
  'sign_in',
  'sign_out',
  'email_changed',
  'profile_updated',
  'device_added',
  'device_removed',
  'account_recovery',
  'security_settings_changed',
  'private_key_exported',
  'backup_created',
  'suspicious_activity',
] as const;

/** How loudly the surface should present the event. */
export const SECURITY_EVENT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];
export type SecurityEventSeverity = (typeof SECURITY_EVENT_SEVERITIES)[number];

/**
 * The severity a writer records when it does not name one itself.
 *
 * It lives beside the vocabulary it is total over, for the same reason the
 * vocabulary does: `services/securityActivityService.ts` is the only consumer
 * and must not import mongoose to reach it. Declaring it
 * `Record<SecurityEventType, SecurityEventSeverity>` is what makes it total —
 * adding an event type above without a default fails `tsc` here rather than
 * silently landing every one of that type at `'low'`.
 *
 * `__tests__/authSession.test.ts` holds it against the Mongoose model's copy
 * until that model is deleted.
 */
export const SECURITY_EVENT_SEVERITY_MAP: Record<SecurityEventType, SecurityEventSeverity> = {
  sign_in: 'low',
  sign_out: 'low',
  profile_updated: 'low',
  email_changed: 'medium',
  device_added: 'medium',
  device_removed: 'medium',
  security_settings_changed: 'medium',
  account_recovery: 'high',
  private_key_exported: 'high',
  backup_created: 'high',
  suspicious_activity: 'critical',
};

/** Two years, matching the Mongo TTL this table's expiry entry replaces. */
export const SECURITY_ACTIVITY_RETENTION_SECONDS = 730 * 24 * 60 * 60;

export const securityActivities = pgTable(
  'security_activities',
  {
    id: generatedId(),
    /** `CASCADE` — the trail belongs to the account and goes with it. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventType: text({ enum: SECURITY_EVENT_TYPES }).notNull(),
    eventDescription: text().notNull(),
    /**
     * Per-event detail. Genuinely shape-less — every event type carries a
     * different set of keys — which is the one thing `jsonb` is for. `{}` is a
     * VALUE here ("no detail"), matching Mongoose's `default: {}`.
     */
    metadata: jsonb().notNull().default({}),
    userAgent: text(),
    /** Central device id the event happened on. Not a row id — see the ledger. */
    deviceId: text(),
    /** When the EVENT happened, not when the row was written. See the header. */
    occurredAt: timestamptz().notNull().defaultNow(),
    severity: text({ enum: SECURITY_EVENT_SEVERITIES }).notNull().default('low'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The activity feed: newest first, scoped to one account.
    index('security_activities_user_id_occurred_at_idx').on(t.userId, t.occurredAt.desc()),
    // …filtered by event type.
    index('security_activities_user_id_event_type_occurred_at_idx').on(
      t.userId,
      t.eventType,
      t.occurredAt.desc()
    ),
    // …filtered to one device.
    index('security_activities_user_id_device_id_occurred_at_idx').on(
      t.userId,
      t.deviceId,
      t.occurredAt.desc()
    ),
    // Supports the expiry sweep in `db/expiry.ts`. None of the compounds above
    // can: each leads with `user_id`, and the sweep is a bare range scan.
    index('security_activities_occurred_at_idx').on(t.occurredAt),
    // Mongo's field-level `{userId:1}`, `{eventType:1}` and `{deviceId:1}` are
    // dropped: the compounds serve any leading `user_id` prefix, and every read
    // of this table is scoped to one account, so an unscoped index on eleven
    // event types or on a device id can never be the cheaper plan.
    check(
      'security_activities_event_type_check',
      sql`${t.eventType} in (${sql.raw(SECURITY_EVENT_TYPES.map((value) => `'${value}'`).join(', '))})`
    ),
    check(
      'security_activities_severity_check',
      sql`${t.severity} in (${sql.raw(SECURITY_EVENT_SEVERITIES.map((value) => `'${value}'`).join(', '))})`
    ),
  ]
);
