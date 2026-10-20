import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { users } from '../users';

beforeAll(connectPostgres);
afterAll(closePostgres);

it('migrates amber while preserving chosen presets and exact legacy hex seeds', async () => {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql.raw('ALTER TABLE users DROP CONSTRAINT users_color_check'));
    const colors = ['amber', '#ABCDEF', '#abc', 'teal', 'mono'];
    const inserted = await tx
      .insert(users)
      .values(
        colors.map((color) => ({
          id: randomUUID(),
          color,
          themePreferenceMode: 'dark' as const,
          themePreferenceColorPreset: color === 'amber' ? 'amber' : 'blue',
        })),
      )
      .returning({ id: users.id });
    await tx.execute(sql.raw('SET CONSTRAINTS ALL IMMEDIATE'));
    // Restore the old+new pre-deploy constraint before testing the post migration.
    const pre = readFileSync(
      resolve(__dirname, '../../../../drizzle/0189_expand_profile_color_catalogue.sql'),
      'utf8',
    );
    await tx.execute(sql.raw(pre.slice(pre.indexOf('ALTER TABLE "users" ADD'))));
    const post = readFileSync(
      resolve(__dirname, '../../../../drizzle/0190_canonical_profile_colors.sql'),
      'utf8',
    );
    await tx.execute(sql.raw(post));
    const finalCheck = readFileSync(
      resolve(__dirname, '../../../../drizzle/0191_canonical_profile_color_check.sql'),
      'utf8',
    );
    await tx.execute(sql.raw(finalCheck));
    const rows = await tx
      .select()
      .from(users)
      .where(
        inArray(
          users.id,
          inserted.map(({ id }) => id),
        ),
      );
    for (const [index, original] of colors.entries()) {
      const row = rows.find(({ id }) => id === inserted[index].id);
      expect(row?.color).toBe(original === 'amber' ? 'yellow' : original);
      expect(row?.themePreferenceColorPreset).toBe(original === 'amber' ? 'yellow' : 'blue');
    }
  });
});
