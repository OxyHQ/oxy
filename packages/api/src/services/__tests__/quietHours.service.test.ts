/**
 * Quiet hours against a real Postgres (ADR 0068): who is quiet at an instant
 * depends on the account's age band and on its own timezone, and an account of
 * unknown age is never quiet.
 */
import { randomBytes } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { accountsInQuietHours, isInQuietHours } from '../quietHours.service';

/** 22:30 UTC: 23:30 in Madrid, 17:30 in New York, 07:30 the next day in Tokyo. */
const AT = new Date('2026-11-17T22:30:00.000Z');

function bornYearsBefore(at: Date, years: number): string {
  return new Date(Date.UTC(at.getUTCFullYear() - years, 0, 15)).toISOString().slice(0, 10);
}

async function account(dateOfBirth: string | null, timezone: string | null): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({
      color: 'teal',
      username: `q${randomBytes(6).toString('hex')}`,
      dateOfBirth,
      preferenceTimezone: timezone,
    })
    .returning({ id: users.id });
  return row.id;
}

beforeAll(connectPostgres);
afterAll(closePostgres);

describe('accountsInQuietHours', () => {
  it('is quiet for a minor whose own clock is inside the window, and for nobody else', async () => {
    const teenMadrid = await account(bornYearsBefore(AT, 15), 'Europe/Madrid');
    const teenNewYork = await account(bornYearsBefore(AT, 15), 'America/New_York');
    const childTokyo = await account(bornYearsBefore(AT, 10), 'Asia/Tokyo');
    const childMadrid = await account(bornYearsBefore(AT, 10), 'Europe/Madrid');
    const adultMadrid = await account(bornYearsBefore(AT, 30), 'Europe/Madrid');
    const unknownMadrid = await account(null, 'Europe/Madrid');

    const quiet = await accountsInQuietHours(
      [teenMadrid, teenNewYork, childTokyo, childMadrid, adultMadrid, unknownMadrid],
      AT,
    );
    expect([...quiet].sort()).toEqual([teenMadrid, childMadrid].sort());
  });

  it('reads a minor with no timezone on UTC time rather than never being quiet', async () => {
    const teen = await account(bornYearsBefore(AT, 16), null);
    expect(await isInQuietHours(teen, AT)).toBe(true);
    expect(await isInQuietHours(teen, new Date('2026-11-17T12:00:00.000Z'))).toBe(false);
  });

  it('stops being quiet at seven in the morning, local time', async () => {
    const teen = await account(bornYearsBefore(AT, 14), 'Europe/Madrid');
    // 05:59 UTC is 06:59 in Madrid; 06:00 UTC is 07:00.
    expect(await isInQuietHours(teen, new Date('2026-11-18T05:59:00.000Z'))).toBe(true);
    expect(await isInQuietHours(teen, new Date('2026-11-18T06:00:00.000Z'))).toBe(false);
  });

  it('answers nothing for no accounts, an unknown one or a repeated one', async () => {
    expect((await accountsInQuietHours([], AT)).size).toBe(0);
    expect((await accountsInQuietHours(['no-such-account'], AT)).size).toBe(0);
    const teen = await account(bornYearsBefore(AT, 15), 'Europe/Madrid');
    expect([...(await accountsInQuietHours([teen, teen], AT))]).toEqual([teen]);
  });
});
