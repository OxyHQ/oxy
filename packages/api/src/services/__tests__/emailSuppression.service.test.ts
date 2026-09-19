/**
 * Suppression list, against a REAL Postgres.
 *
 * The scope rule is the whole design and the only thing worth testing hard: a
 * permanent bounce is a property of the ADDRESS and binds everyone, a complaint
 * is a property of the (sender, recipient) PAIR and binds only that sender.
 * Collapsing the two either leaks one user's reputation onto every other user's
 * mail, or throws away the global signal that protects the domain.
 */

import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { emailSuppressions } from '../../db/schema/emailSuppressions';
import { eq } from 'drizzle-orm';
import {
  findSuppressed,
  liftSuppression,
  normalizeAddress,
  recordSuppression,
} from '../emailSuppression.service';

const unique = () => randomUUID().replace(/-/g, '');

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

async function account(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `sup${unique().slice(0, 12)}`, color: 'teal' })
    .returning({ id: users.id });
  return row.id;
}

const addr = () => `victim-${unique().slice(0, 12)}@example.com`;

describe('normalizeAddress', () => {
  it('lower-cases and trims, so a lookup cannot miss on case', () => {
    expect(normalizeAddress('  Juan@Empresa.COM ')).toBe('juan@empresa.com');
  });
});

describe('scope', () => {
  it('a permanent bounce binds every sender', async () => {
    const [alice, bob] = [await account(), await account()];
    const address = addr();

    await recordSuppression({
      address,
      reason: 'bounce_permanent',
      source: 'ses',
      diagnostic: 'smtp; 550 5.1.1 user unknown',
      userId: null,
    });

    for (const userId of [alice, bob]) {
      const hits = await findSuppressed(userId, [address]);
      expect(hits).toHaveLength(1);
      expect(hits[0].reason).toBe('bounce_permanent');
      expect(hits[0].diagnostic).toContain('user unknown');
    }
  });

  it('a complaint binds only the sender it was filed against', async () => {
    const [reported, innocent] = [await account(), await account()];
    const address = addr();

    await recordSuppression({
      address,
      reason: 'complaint',
      source: 'ses',
      userId: reported,
    });

    expect(await findSuppressed(reported, [address])).toHaveLength(1);
    // The whole point: another account holder is a different correspondent.
    expect(await findSuppressed(innocent, [address])).toHaveLength(0);
  });

  it('refuses an unscoped complaint at the database level', async () => {
    await expect(
      getDb().insert(emailSuppressions).values({
        userId: null,
        address: addr(),
        reason: 'complaint',
        source: 'ses',
      }),
    ).rejects.toThrow();
  });
});

describe('transient bounces', () => {
  it('suppresses now and stops suppressing once expired', async () => {
    const userId = await account();
    const address = addr();

    await recordSuppression({ address, reason: 'bounce_transient', source: 'ses', userId: null });
    expect(await findSuppressed(userId, [address])).toHaveLength(1);

    // A full mailbox must not become a permanent verdict. Age the row past its
    // deadline and it stops binding, with no sweep involved — the read filters.
    await getDb()
      .update(emailSuppressions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(emailSuppressions.address, address));

    expect(await findSuppressed(userId, [address])).toHaveLength(0);
  });

  it('a later permanent bounce replaces the transient one and clears its expiry', async () => {
    const userId = await account();
    const address = addr();

    await recordSuppression({ address, reason: 'bounce_transient', source: 'ses', userId: null });
    await recordSuppression({ address, reason: 'bounce_permanent', source: 'ses', userId: null });

    const rows = await getDb()
      .select()
      .from(emailSuppressions)
      .where(eq(emailSuppressions.address, address));
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('bounce_permanent');
    expect(rows[0].expiresAt).toBeNull();
  });
});

describe('findSuppressed', () => {
  it('checks the whole recipient list in one query and matches case-insensitively', async () => {
    const userId = await account();
    const bad = addr();
    const good = addr();
    await recordSuppression({ address: bad, reason: 'bounce_permanent', source: 'ses', userId: null });

    const hits = await findSuppressed(userId, [bad.toUpperCase(), good, `  ${bad}  `]);
    expect(hits.map((h) => h.address)).toEqual([bad]);
  });

  it('is empty for an empty or blank recipient list', async () => {
    const userId = await account();
    expect(await findSuppressed(userId, [])).toEqual([]);
    expect(await findSuppressed(userId, ['', '   '])).toEqual([]);
  });
});

describe('liftSuppression', () => {
  it('removes a global row and reports whether anything was removed', async () => {
    const userId = await account();
    const address = addr();
    await recordSuppression({ address, reason: 'bounce_permanent', source: 'ses', userId: null });

    expect(await liftSuppression(null, address)).toBe(true);
    expect(await findSuppressed(userId, [address])).toHaveLength(0);
    expect(await liftSuppression(null, address)).toBe(false);
  });

  it('a scoped lift does not remove the global row', async () => {
    const userId = await account();
    const address = addr();
    await recordSuppression({ address, reason: 'bounce_permanent', source: 'ses', userId: null });

    expect(await liftSuppression(userId, address)).toBe(false);
    expect(await findSuppressed(userId, [address])).toHaveLength(1);
  });
});
