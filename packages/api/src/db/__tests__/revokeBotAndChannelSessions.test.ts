/**
 * The REPAIR, which is a different property from the prevention.
 *
 * `personPathsDoNotUseDelegatedActAs.test.ts` and the switch-route tests cover
 * what the change PREVENTS: no person may switch into a bot or a channel from
 * now on. This covers what it REPAIRS: the sessions that already exist.
 *
 * They are not the same guarantee and neither implies the other. Closing a door
 * does not remove whoever is already through it — production had one such person
 * on 2026-08-25, holding a live `community-maestro` session on the same device as
 * their personal login — so a fix with only the first half is a fix for the next
 * person and not for the one already inside.
 *
 * ## Why this runs the migration's own SQL
 *
 * The statement under test is `0058_revoke_person_sessions_on_bots_and_channels`,
 * and it is READ FROM THE FILE rather than restated here. A copy of the SQL in a
 * test proves the copy works; a divergence between the copy and the file is
 * invisible and would leave the shipped statement untested, which is the exact
 * class of defect this whole change is about.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { sessions } from '../schema/sessions';
import { users } from '../schema/users';
import type { AccountKind } from '../schema/users';

const MIGRATION = join(
  __dirname,
  '..',
  '..',
  '..',
  'drizzle',
  '0058_revoke_person_sessions_on_bots_and_channels.sql'
);

/** The statement itself, with the phase marker and the reasoning stripped. */
function revocationStatement(): string {
  const file = readFileSync(MIGRATION, 'utf8');
  const statement = file
    .split('\n')
    .filter((line) => !line.startsWith('--'))
    .join('\n')
    .trim();
  // A filter that ate the statement would make every assertion below vacuous.
  if (!statement.toUpperCase().startsWith('UPDATE')) {
    throw new Error(`Expected an UPDATE in ${MIGRATION}, got: ${statement.slice(0, 80)}`);
  }
  return statement;
}

async function runRevocation(): Promise<void> {
  await getDb().execute(sql.raw(revocationStatement()));
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

let counter = 0;
/** The whole run shares one database, so every test mints its own rows. */
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}z${Date.now().toString(36)}`;
}

async function accountWithSession(
  kind: AccountKind,
  options: { active?: boolean } = {}
): Promise<{ accountId: string; sessionId: string }> {
  const [account] = await getDb()
    .insert(users)
    .values({ color: 'teal', kind, username: unique(kind) })
    .returning();
  const [session] = await getDb()
    .insert(sessions)
    .values({
      sessionId: unique('sess'),
      userId: account.id,
      deviceId: unique('dev'),
      deviceType: 'web',
      platform: 'web',
      accessToken: unique('at'),
      refreshToken: unique('rt'),
      isActive: options.active ?? true,
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    .returning();
  return { accountId: account.id, sessionId: session.sessionId };
}

async function isActive(sessionId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ isActive: sessions.isActive })
    .from(sessions)
    .where(eq(sessions.sessionId, sessionId))
    .limit(1);
  return row.isActive;
}

describe('the deploy revokes what the new rule forbids', () => {
  it('revokes a live session whose subject is a BOT', async () => {
    const bot = await accountWithSession('bot');

    await runRevocation();

    expect(await isActive(bot.sessionId)).toBe(false);
  });

  /**
   * Zero channel sessions exist today — the kind has been refused since before
   * this change. It is named in the statement by the RULE rather than by the
   * census, so that a channel minted next month cannot slip through a statement
   * tuned to what happened to be there on the day it was written. This is what
   * makes that claim true rather than aspirational.
   */
  it('revokes a live session whose subject is a CHANNEL, though none exists today', async () => {
    const channel = await accountWithSession('channel');

    await runRevocation();

    expect(await isActive(channel.sessionId)).toBe(false);
  });

  /**
   * The positive control, and the assertion that matters most: this must be a
   * SCALPEL. A statement that revoked everything would satisfy both assertions
   * above and log every person out of the platform.
   */
  it.each(['personal', 'organization', 'project'] as const)(
    'leaves a %s session alone',
    async (kind) => {
      const spared = await accountWithSession(kind);

      await runRevocation();

      expect(await isActive(spared.sessionId)).toBe(true);
    }
  );

  it('is idempotent: a second run revokes nothing further and does not fail', async () => {
    const bot = await accountWithSession('bot');
    const person = await accountWithSession('personal');

    await runRevocation();
    await runRevocation();
    await runRevocation();

    expect(await isActive(bot.sessionId)).toBe(false);
    expect(await isActive(person.sessionId)).toBe(true);
  });

  /**
   * Reading the state back is what the count is FOR: after the deploy, no bot or
   * channel may hold an active session.
   *
   * Asked as the same JOIN the production read-back uses, but restricted to the
   * accounts this test minted. The whole suite shares ONE database and its files
   * run in parallel, so an unrestricted `kind in ('bot','channel') and is_active`
   * would be answering for a sibling's fixtures as well — green or red by
   * timing. The "not too narrow" worry that would otherwise argue for the global
   * query is already covered by the per-kind controls above.
   */
  it('leaves zero active bot or channel sessions behind', async () => {
    const bot = await accountWithSession('bot');
    const channel = await accountWithSession('channel');

    await runRevocation();

    const remaining = await getDb()
      .select({ sessionId: sessions.sessionId })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        sql`${users.kind} in ('bot','channel')
            and ${sessions.isActive}
            and ${users.id} in (${bot.accountId}, ${channel.accountId})`
      );

    expect(remaining).toEqual([]);
  });

  /**
   * A session that was ALREADY revoked is untouched, which is what makes the
   * statement's `and s."is_active"` clause load-bearing rather than decorative:
   * without it the second run would rewrite `updated_at` on rows it did not
   * change, and "when was this revoked" would move every time anybody re-ran a
   * deploy.
   */
  it('does not rewrite a session it already revoked', async () => {
    const bot = await accountWithSession('bot', { active: false });
    const [before] = await getDb()
      .select({ updatedAt: sessions.updatedAt })
      .from(sessions)
      .where(eq(sessions.sessionId, bot.sessionId))
      .limit(1);

    await runRevocation();

    const [after] = await getDb()
      .select({ updatedAt: sessions.updatedAt })
      .from(sessions)
      .where(eq(sessions.sessionId, bot.sessionId))
      .limit(1);

    expect(after.updatedAt).toEqual(before.updatedAt);
  });
});
