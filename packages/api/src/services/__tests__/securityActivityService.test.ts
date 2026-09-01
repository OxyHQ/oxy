/**
 * The account's own audit trail, against a REAL Postgres.
 *
 * This file exists for ONE guarantee above all others: **an account created
 * after the Postgres cutover still gets a security-activity trail.**
 *
 * The code this replaces opened every method with
 *
 * ```ts
 * if (!Types.ObjectId.isValid(userId)) throw new Error('Invalid userId');
 * ```
 *
 * and every account created after the cutover carries a **uuid v7** id
 * (`@oxyhq/db`'s `generatedId()`), which that regex rejects. So for such
 * an account the write threw before touching a table and the read threw before
 * querying — sign-in, sign-out, email change, device added, profile update, all
 * of it. Because almost every caller `await`s the helper inside a `try` that
 * swallows, the symptom was an audit history that silently stayed empty; on the
 * two `POST /security/activity/*` routes the same throw surfaced as an HTTP 500.
 *
 * So every id here is one `generatedId()` actually mints, taken from a real
 * inserted `users` row rather than a hex literal, and the first `describe`
 * asserts the format is NOT 24-hex so the cases cannot pass vacuously. Reinstate
 * the guard and `records a sign-in …` goes red naming the dropped event.
 *
 * The previous suite for this service did not exist; the endpoint's controller
 * test mocked the service outright and said so, noting that "this endpoint never
 * returns another user's rows" is a property of a QUERY that a mocked query
 * cannot hold. That check now lives here, against real rows.
 */

import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { desc, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { securityActivities } from '../../db/schema/securityActivities';
import { users } from '../../db/schema/users';
import securityActivityService from '../securityActivityService';

/** A real account row, so the id under test is one the schema actually mints. */
async function insertUser(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ color: 'teal' })
    .returning({ id: users.id });
  return row.id;
}

/** Every stored row for one account, newest event first. */
async function storedRows(userId: string) {
  return getDb()
    .select()
    .from(securityActivities)
    .where(eq(securityActivities.userId, userId))
    .orderBy(desc(securityActivities.occurredAt));
}

/**
 * Seed one event directly, so a read-path case controls `occurredAt` exactly.
 *
 * The service always stamps `new Date()`, and its 5-second deduplication window
 * would collapse a loop of same-type writes into one row — neither of which lets
 * a pagination or ordering case say what it means.
 */
async function seedEvent(
  userId: string,
  values: Partial<typeof securityActivities.$inferInsert> = {}
): Promise<string> {
  const [row] = await getDb()
    .insert(securityActivities)
    .values({
      userId,
      eventType: 'sign_in',
      eventDescription: 'User signed in',
      severity: 'low',
      ...values,
    })
    .returning({ id: securityActivities.id });
  return row.id;
}

/** A request carrying only the headers `extractDeviceInfo` reads. */
function makeRequest(headers: Record<string, string> = {}): Request {
  return { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120', ...headers } } as unknown as Request;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('the id format must not decide whether the trail is written', () => {
  it('mints account ids that the deleted 24-hex guard would have rejected', async () => {
    // The premise every case below rests on. Without this, reinstating the guard
    // would leave the suite green and prove nothing.
    const userId = await insertUser();
    expect(userId).not.toMatch(/^[0-9a-f]{24}$/i);
  });

  it('records a sign-in for an account created after the cutover — the event is not dropped', async () => {
    const userId = await insertUser();

    const result = await securityActivityService.logSignIn(userId, makeRequest(), 'device-1');

    // Returned…
    expect(result).not.toBeNull();
    expect(result?.userId).toBe(userId);
    expect(result?.eventType).toBe('sign_in');
    // …and actually STORED. The returned object alone cannot tell the two apart:
    // the Mongo version returned a row-shaped value for events it never wrote.
    const rows = await storedRows(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventDescription).toBe('User signed in');
    expect(rows[0].deviceId).toBe('device-1');
  });

  it('reads the trail back for a post-cutover account, rather than throwing', async () => {
    const userId = await insertUser();
    await seedEvent(userId, { eventType: 'device_added', eventDescription: 'New device added: Pixel' });

    const page = await securityActivityService.getUserSecurityActivity(userId);

    expect(page.total).toBe(1);
    expect(page.activities[0].eventType).toBe('device_added');
  });

  it('returns the recent trail for a post-cutover account', async () => {
    const userId = await insertUser();
    await seedEvent(userId, { eventType: 'backup_created', eventDescription: 'Encrypted backup file created' });

    const recent = await securityActivityService.getRecentSecurityActivity(userId);

    expect(recent).toHaveLength(1);
    expect(recent[0].eventType).toBe('backup_created');
  });

  it('logs every event type for a post-cutover account', async () => {
    // The guard sat in `logSecurityEvent`, so it took out the whole vocabulary —
    // not one helper. Each helper writes its own event type.
    const userId = await insertUser();

    await securityActivityService.logSignIn(userId, makeRequest(), 'd1');
    await securityActivityService.logSignOut(userId, makeRequest(), 'd1');
    await securityActivityService.logEmailChange(userId, 'a@oxy.so', 'b@oxy.so');
    await securityActivityService.logProfileUpdate(userId, ['bio']);
    await securityActivityService.logDeviceAdded(userId, 'd2', 'Pixel');
    await securityActivityService.logDeviceRemoved(userId, 'd3', 'Pixel');
    await securityActivityService.logAccountRecovery(userId, 'recovery phrase');
    await securityActivityService.logSecuritySettingsChange(userId, '2fa', false, true);
    await securityActivityService.logSuspiciousActivity(userId, 'Impossible travel');
    await securityActivityService.logPrivateKeyExported(userId);
    await securityActivityService.logBackupCreated(userId);

    const rows = await storedRows(userId);
    expect(rows.map((row) => row.eventType).sort()).toEqual([
      'account_recovery',
      'backup_created',
      'device_added',
      'device_removed',
      'email_changed',
      'private_key_exported',
      'profile_updated',
      'security_settings_changed',
      'sign_in',
      'sign_out',
      'suspicious_activity',
    ]);
  });
});

describe('what a write stores', () => {
  it('derives the default severity from the event type when the caller names none', async () => {
    const userId = await insertUser();

    await securityActivityService.logSecurityEvent({
      userId,
      eventType: 'suspicious_activity',
      eventDescription: 'Impossible travel',
    });

    const [row] = await storedRows(userId);
    expect(row.severity).toBe('critical');
  });

  it("lets the caller's explicit severity win over the default", async () => {
    const userId = await insertUser();

    await securityActivityService.logSecurityEvent({
      userId,
      eventType: 'sign_in',
      eventDescription: 'User signed in',
      severity: 'high',
    });

    const [row] = await storedRows(userId);
    expect(row.severity).toBe('high');
  });

  it('strips control characters from the description and caps it at 500 characters', async () => {
    const userId = await insertUser();

    await securityActivityService.logSecurityEvent({
      userId,
      eventType: 'profile_updated',
      eventDescription: `bad\u0000\u0007value ${'x'.repeat(600)}`,
    });

    const [row] = await storedRows(userId);
    expect(row.eventDescription).not.toMatch(/[\x00-\x1F\x7F]/);
    expect(row.eventDescription.length).toBe(500);
    expect(row.eventDescription.startsWith('badvalue ')).toBe(true);
  });

  it('substitutes a default description when sanitization removes everything', async () => {
    const userId = await insertUser();

    await securityActivityService.logSecurityEvent({
      userId,
      eventType: 'sign_out',
      eventDescription: '\u0000\u0001\u0002',
    });

    const [row] = await storedRows(userId);
    expect(row.eventDescription).toBe('Security event: sign_out');
  });

  it('reduces oversized metadata rather than storing it', async () => {
    const userId = await insertUser();

    await securityActivityService.logSecurityEvent({
      userId,
      eventType: 'sign_in',
      eventDescription: 'User signed in',
      metadata: { blob: 'y'.repeat(20000) },
    });

    const [row] = await storedRows(userId);
    expect(row.metadata).toEqual({ truncated: true });
  });

  it('stores metadata as an object, and an absent one as `{}`', async () => {
    const userId = await insertUser();

    await securityActivityService.logEmailChange(userId, 'old@oxy.so', 'new@oxy.so');
    const [changed] = await storedRows(userId);
    expect(changed.metadata).toEqual({ oldValue: 'old@oxy.so', newValue: 'new@oxy.so' });

    const other = await insertUser();
    await securityActivityService.logSecurityEvent({
      userId: other,
      eventType: 'sign_in',
      eventDescription: 'User signed in',
    });
    const [bare] = await storedRows(other);
    expect(bare.metadata).toEqual({});
  });

  it('captures and caps the user agent, and derives a device id from the request', async () => {
    const userId = await insertUser();

    const record = await securityActivityService.logSecurityEvent({
      userId,
      eventType: 'sign_in',
      eventDescription: 'User signed in',
      req: makeRequest({ 'user-agent': 'A'.repeat(900) }),
    });

    const [row] = await storedRows(userId);
    expect(row.userAgent?.length).toBe(500);
    // No deviceId was supplied, so one is derived from the request and scoped to
    // this user (security review H1) rather than left null.
    expect(row.deviceId).toEqual(expect.any(String));
    expect(record?.deviceId).toBe(row.deviceId);
  });

  it('records the event time in `occurred_at`, distinct from the row write time', async () => {
    const userId = await insertUser();
    const before = Date.now();

    const record = await securityActivityService.logSignIn(userId, makeRequest());

    const [row] = await storedRows(userId);
    expect(row.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(record?.occurredAt).toEqual(row.occurredAt);
    // Both columns exist and are populated; the DTO's `timestamp` is built from
    // `occurred_at` in the controller, never from `created_at`.
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('exposes a FIXED field set, so a new column cannot silently join the read', async () => {
    const userId = await insertUser();
    const record = await securityActivityService.logSignIn(userId, makeRequest(), 'd1');

    expect(Object.keys(record ?? {}).sort()).toEqual([
      'createdAt',
      'deviceId',
      'eventDescription',
      'eventType',
      'id',
      'metadata',
      'occurredAt',
      'severity',
      'userAgent',
      'userId',
    ]);
  });

  it('persists no IP address, in any column, for any event it writes', async () => {
    // Platform-wide no-user-IPs-at-rest invariant. The service is the one writer
    // of this table, so "the table has no IP column" and "this writer never
    // produces one" are different claims; this is the second.
    const userId = await insertUser();
    await securityActivityService.logSignIn(userId, makeRequest({ 'x-forwarded-for': '203.0.113.7' }), 'd1');

    const [row] = await storedRows(userId);
    expect(JSON.stringify(row)).not.toContain('203.0.113.7');
  });
});

describe('deduplication', () => {
  it('suppresses a repeat within the window and returns the row already stored', async () => {
    const userId = await insertUser();

    const first = await securityActivityService.logSignIn(userId, makeRequest(), 'device-1');
    const second = await securityActivityService.logSignIn(userId, makeRequest(), 'device-1');

    // The Mongo version fabricated `_id: new Types.ObjectId()` here — a row-shaped
    // value whose id named no record anywhere. The suppressed call now answers
    // with the row that IS stored.
    expect(second?.id).toBe(first?.id);
    expect(await storedRows(userId)).toHaveLength(1);
  });

  it('does not let one account suppress another account\'s event', async () => {
    const a = await insertUser();
    const b = await insertUser();

    await securityActivityService.logSignIn(a, makeRequest(), 'shared-device');
    await securityActivityService.logSignIn(b, makeRequest(), 'shared-device');

    expect(await storedRows(a)).toHaveLength(1);
    expect(await storedRows(b)).toHaveLength(1);
  });

  it('keeps a repeat on a DIFFERENT device for device-scoped event types', async () => {
    const userId = await insertUser();

    await securityActivityService.logSignIn(userId, makeRequest(), 'device-1');
    await securityActivityService.logSignIn(userId, makeRequest(), 'device-2');

    expect(await storedRows(userId)).toHaveLength(2);
  });

  it('does not suppress a different event type', async () => {
    const userId = await insertUser();

    await securityActivityService.logSignIn(userId, makeRequest(), 'device-1');
    await securityActivityService.logSignOut(userId, makeRequest(), 'device-1');

    expect(await storedRows(userId)).toHaveLength(2);
  });

  it('does not consider an event older than the window a duplicate', async () => {
    const userId = await insertUser();
    // Ten seconds back, twice the 5s window.
    await seedEvent(userId, { occurredAt: new Date(Date.now() - 10_000), deviceId: 'device-1' });

    await securityActivityService.logSignIn(userId, makeRequest(), 'device-1');

    expect(await storedRows(userId)).toHaveLength(2);
  });
});

describe('a write that cannot land', () => {
  it('returns null for an account that does not exist, and never throws', async () => {
    // The foreign key on `security_activities.user_id` is what refuses this —
    // the deleted regex only ever guessed at the id's SHAPE, and this id is
    // perfectly well-shaped. Audit logging must not break the operation it
    // describes, so the failure is logged and swallowed; `null` is how the
    // caller can tell, which the Mongo version's fabricated document could not.
    const record = await securityActivityService.logSecurityEvent({
      userId: randomUUID(),
      eventType: 'sign_in',
      eventDescription: 'User signed in',
    });

    expect(record).toBeNull();
  });
});

describe('reading the trail', () => {
  it('never returns another account\'s rows', async () => {
    // The guarantee the controller suite could not hold, because it is a
    // property of the QUERY. The controller proves no request-supplied value
    // widens the input; this proves the predicate itself is scoped.
    const mine = await insertUser();
    const theirs = await insertUser();
    await seedEvent(mine, { eventDescription: 'mine' });
    await seedEvent(theirs, { eventDescription: 'theirs' });

    const page = await securityActivityService.getUserSecurityActivity(mine);

    expect(page.total).toBe(1);
    expect(page.activities.map((a) => a.eventDescription)).toEqual(['mine']);
    expect(page.activities.every((a) => a.userId === mine)).toBe(true);
  });

  it('orders newest event first, by the EVENT time', async () => {
    const userId = await insertUser();
    await seedEvent(userId, { eventDescription: 'oldest', occurredAt: new Date('2026-01-01T00:00:00Z') });
    await seedEvent(userId, { eventDescription: 'newest', occurredAt: new Date('2026-03-01T00:00:00Z') });
    await seedEvent(userId, { eventDescription: 'middle', occurredAt: new Date('2026-02-01T00:00:00Z') });

    const page = await securityActivityService.getUserSecurityActivity(userId);

    expect(page.activities.map((a) => a.eventDescription)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('paginates with an accurate total and hasMore', async () => {
    const userId = await insertUser();
    for (let index = 0; index < 5; index += 1) {
      await seedEvent(userId, {
        eventDescription: `event-${index}`,
        occurredAt: new Date(Date.UTC(2026, 0, index + 1)),
      });
    }

    const first = await securityActivityService.getUserSecurityActivity(userId, { limit: 2, offset: 0 });
    expect(first.total).toBe(5);
    expect(first.hasMore).toBe(true);
    expect(first.activities.map((a) => a.eventDescription)).toEqual(['event-4', 'event-3']);

    const last = await securityActivityService.getUserSecurityActivity(userId, { limit: 2, offset: 4 });
    expect(last.total).toBe(5);
    expect(last.hasMore).toBe(false);
    expect(last.activities.map((a) => a.eventDescription)).toEqual(['event-0']);
  });

  it('counts only the filtered set when an event type is named', async () => {
    // The total has to agree with the filter, or the page footer reports a
    // different collection from the one on screen.
    const userId = await insertUser();
    await seedEvent(userId, { eventType: 'sign_in', eventDescription: 'in' });
    await seedEvent(userId, { eventType: 'sign_out', eventDescription: 'out' });
    await seedEvent(userId, { eventType: 'sign_out', eventDescription: 'out again' });

    const page = await securityActivityService.getUserSecurityActivity(userId, { eventType: 'sign_out' });

    expect(page.total).toBe(2);
    expect(page.activities.map((a) => a.eventType)).toEqual(['sign_out', 'sign_out']);
  });

  it('clamps the limit to 100 and floors the offset at 0', async () => {
    const userId = await insertUser();
    await seedEvent(userId);

    const page = await securityActivityService.getUserSecurityActivity(userId, {
      limit: 5000,
      offset: -10,
    });

    // A negative offset would otherwise be a Postgres syntax error rather than a
    // clamped read.
    expect(page.total).toBe(1);
    expect(page.activities).toHaveLength(1);
    expect(page.hasMore).toBe(false);
  });

  it('reports an empty trail as a page rather than an error', async () => {
    const userId = await insertUser();

    const page = await securityActivityService.getUserSecurityActivity(userId);

    expect(page).toEqual({ activities: [], total: 0, hasMore: false });
  });

  it('getRecentSecurityActivity returns the newest N, scoped to the account', async () => {
    const userId = await insertUser();
    const other = await insertUser();
    await seedEvent(other, { eventDescription: 'theirs' });
    for (let index = 0; index < 4; index += 1) {
      await seedEvent(userId, {
        eventDescription: `event-${index}`,
        occurredAt: new Date(Date.UTC(2026, 0, index + 1)),
      });
    }

    const recent = await securityActivityService.getRecentSecurityActivity(userId, 2);

    expect(recent.map((a) => a.eventDescription)).toEqual(['event-3', 'event-2']);
  });

  it('getRecentSecurityActivity clamps a nonsensical limit instead of failing', async () => {
    const userId = await insertUser();
    await seedEvent(userId);

    await expect(securityActivityService.getRecentSecurityActivity(userId, 0)).resolves.toHaveLength(1);
    await expect(securityActivityService.getRecentSecurityActivity(userId, -5)).resolves.toHaveLength(1);
  });

  it('presents a non-object stored metadata as `{}` rather than handing it on', async () => {
    // Nothing in the service writes one, but `psql`, a backfill and a future
    // writer all can — and a consumer that spreads a JSON scalar gets nonsense.
    const userId = await insertUser();
    await seedEvent(userId, { metadata: 'not-an-object' });

    const page = await securityActivityService.getUserSecurityActivity(userId);

    expect(page.activities[0].metadata).toEqual({});
  });
});
