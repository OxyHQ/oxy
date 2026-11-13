/**
 * 0257 and 0258: a bot's colour is its account's, so its character loses its paint. The test
 * database was migrated from empty, so the statement is REPLAYED over rows shaped like production's
 * before the cut, inside a transaction that is rolled back.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { MIGRATIONS_FOLDER } from '../../migrationsFolder';
import { users } from '../users';

const statementOf = (file: string): string =>
  readFileSync(join(MIGRATIONS_FOLDER, file), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.replace(/^--.*$/gm, '').trim())
    .filter((statement) => statement !== '')
    .join(';\n');

class Rollback extends Error {}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('bot characters without a paint', () => {
  it('0257 (pre) and 0258 (post) are the same strip, in the two phases', () => {
    const pre = readFileSync(
      join(MIGRATIONS_FOLDER, '0257_bot_characters_without_paint.sql'),
      'utf8',
    );
    const post = readFileSync(
      join(MIGRATIONS_FOLDER, '0258_bot_characters_without_paint_after_rollout.sql'),
      'utf8',
    );
    expect(pre).toMatch(/^-- oxy:deploy-phase=pre/);
    expect(post).toMatch(/^-- oxy:deploy-phase=post/);
    expect(statementOf('0257_bot_characters_without_paint.sql')).toBe(
      statementOf('0258_bot_characters_without_paint_after_rollout.sql'),
    );
  });

  it('removes the named and the free paint, and keeps every other part', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const before: Record<string, object> = {
      named: { shape: 'pebble', eyes: 'oval', eyewear: 'none', accessory: 'none', color: 'coral' },
      free: { preset: 'clippo', accessory: 'bow', bodyColor: '#1dff00' },
      none: { shape: 'cloud', eyes: 'oval' },
    };
    let after: Record<string, unknown> = {};
    try {
      await getDb().transaction(async (tx) => {
        for (const [name, character] of Object.entries(before)) {
          // The shape before the cut: a paint the contract no longer has a type for.
          await tx.insert(users).values({
            username: `paint${name}${suffix}bot`,
            kind: 'bot',
            color: 'teal',
            character: character as never,
          });
        }
        await tx.execute(sql.raw(statementOf('0257_bot_characters_without_paint.sql')));
        const rows = await tx.execute<{ username: string; character: unknown }>(
          sql`select username, character from users where username like ${`paint%${suffix}bot`}`,
        );
        after = Object.fromEntries(
          rows.map((row) => [
            row.username.slice('paint'.length, -(suffix.length + 3)),
            row.character,
          ]),
        );
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    expect(after).toEqual({
      named: { shape: 'pebble', eyes: 'oval', eyewear: 'none', accessory: 'none' },
      free: { preset: 'clippo', accessory: 'bow' },
      none: { shape: 'cloud', eyes: 'oval' },
    });
  });
});
