/**
 * A taken username is REFUSED, never renamed — and refused the same way whether
 * it was taken long ago or a moment before the write.
 *
 * ## What this replaces
 *
 * `AccountService` used to suffix a counter on collision: ask for `pepe`, get
 * `pepe1`, and nobody is told. The consumers were already written for a refusal:
 * Alia's `bot-account.ts` retries with a fresh suggestion on **409**.
 *
 * ## One detection: the index
 *
 * There is no availability probe. `users_lower_username_key` decides, and
 * `accountCreation.service.ts` translates its violation — only that index, by
 * name — into `UsernameTakenError`, a 409 naming the field. An untranslated
 * driver error would be a **500** a retrying client cannot act on.
 *
 * Firing N creations at once does not RELIABLY reach the contended path. `forces
 * the loser onto the constraint` below takes it deliberately: an UNCOMMITTED
 * transaction holds the row (invisible to the racer, asserted), the racer's
 * insert blocks on the index (waited for in `pg_locks`, not slept on), and only
 * then does the holder commit. The test FAILS if it cannot establish that setup,
 * so it can never pass vacuously.
 */

import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { accountService } from '../account.service';
import { ApiError } from '../../utils/error';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

let counter = 0;
/** The whole run shares one database, so every test mints its own names. */
function uniqueUsername(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}z${Date.now().toString(36)}`;
}

async function seedOwner(): Promise<string> {
  const [owner] = await getDb()
    .insert(users)
    .values({ color: 'teal', kind: 'personal', username: uniqueUsername('owner') })
    .returning();
  return owner.id;
}

/** The status an error carries, or `null` for something that is not an `ApiError`. */
function statusOf(error: unknown): number | null {
  return error instanceof ApiError ? error.statusCode : null;
}

describe('a taken username is refused, not renamed', () => {
  it('409s instead of allocating a suffix', async () => {
    const ownerId = await seedOwner();
    const username = uniqueUsername('taken');

    await accountService.createChildAccount(ownerId, ownerId, { kind: 'project', username });

    await expect(
      accountService.createChildAccount(ownerId, ownerId, { kind: 'project', username }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  /**
   * The positive control for the assertion above: a suffixed account must not
   * exist. A `ConflictError` thrown AFTER the row was written would satisfy the
   * rejection above and still leave the orphan the old code produced.
   */
  it('and writes nothing — no suffixed account is left behind', async () => {
    const ownerId = await seedOwner();
    const username = uniqueUsername('orphan');

    await accountService.createChildAccount(ownerId, ownerId, { kind: 'project', username });
    await accountService
      .createChildAccount(ownerId, ownerId, { kind: 'project', username })
      .catch(() => undefined);

    const rows = await getDb()
      .select({ username: users.username })
      .from(users)
      .where(sql`${users.username} like ${`${username}%`}`);

    expect(rows.map((row) => row.username)).toEqual([username]);
  });

  it('conflicts case-insensitively, because the index does', async () => {
    const ownerId = await seedOwner();
    const username = uniqueUsername('mixed');

    await accountService.createChildAccount(ownerId, ownerId, { kind: 'project', username });

    await expect(
      accountService.createChildAccount(ownerId, ownerId, {
        kind: 'project',
        username: username.toUpperCase(),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('409s on a RENAME into a taken handle', async () => {
    const ownerId = await seedOwner();
    const taken = uniqueUsername('held');
    await accountService.createChildAccount(ownerId, ownerId, { kind: 'project', username: taken });
    const { account } = await accountService.createChildAccount(ownerId, ownerId, {
      kind: 'project',
      username: uniqueUsername('mover'),
    });

    await expect(
      accountService.updateAccount(account.id, { username: taken }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('lets an account keep its own name on an unrelated edit', async () => {
    const ownerId = await seedOwner();
    const username = uniqueUsername('selfsame');
    const { account } = await accountService.createChildAccount(ownerId, ownerId, {
      kind: 'project',
      username,
    });

    const updated = await accountService.updateAccount(account.id, { username, bio: 'unchanged' });

    expect(updated.username).toBe(username);
  });

  it('names the field, so a client knows what to change', async () => {
    const ownerId = await seedOwner();
    const username = uniqueUsername('field');
    await accountService.createChildAccount(ownerId, ownerId, { kind: 'project', username });

    await expect(
      accountService.createChildAccount(ownerId, ownerId, { kind: 'project', username }),
    ).rejects.toMatchObject({ details: { field: 'username' } });
  });
});

describe('the lost race gets the same answer as a name taken long ago', () => {
  /**
   * Wait until a backend is BLOCKED on the users index, rather than sleeping.
   *
   * The point of the whole test is that the racer reached the insert, and a
   * `setTimeout` only assumes it. This observes it: an insert waiting on a lock
   * IS the racer contending for the name.
   *
   * Returns false if it never blocks, and the caller fails the test — a run that
   * could not establish the race must be RED, never a quiet pass.
   */
  async function waitForBlockedInsert(): Promise<boolean> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const blocked = await getDb().execute(sql`
        select 1 from pg_stat_activity
        where wait_event_type = 'Lock'
          and query ilike '%insert into "users"%'
          and pid <> pg_backend_pid()
        limit 1
      `);
      if (blocked.length > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  }

  /**
   * The real thing: the loser goes through `users_lower_username_key` while the
   * winner's row is still uncommitted.
   *
   * An uncommitted transaction holds the name — invisible to the racer, asserted
   * below — the racer's insert blocks on the index, and the holder commits only
   * once that block is observed.
   */
  it('forces the loser onto the constraint, and it is still a 409', async () => {
    const ownerId = await seedOwner();
    const username = uniqueUsername('forced');

    let commitHolder!: () => void;
    const held = new Promise<void>((resolve) => {
      commitHolder = resolve;
    });
    let holderReady!: () => void;
    const inserted = new Promise<void>((resolve) => {
      holderReady = resolve;
    });

    const holder = getDb().transaction(async (tx) => {
      await tx.insert(users).values({ color: 'teal', kind: 'project', username });
      holderReady();
      await held;
    });
    await inserted;

    // The precondition, asserted rather than assumed: the row is invisible
    // outside the open transaction, so the racer's insert is what meets it.
    const visibleNow = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(btrim(${users.username})) = lower(btrim(${username}))`);
    expect(visibleNow).toHaveLength(0);

    const racer = accountService
      .createChildAccount(ownerId, ownerId, { kind: 'project', username })
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, status: statusOf(error) }),
      );

    const reachedTheInsert = await waitForBlockedInsert();
    commitHolder();
    await holder;
    const outcome = await racer;

    // If this fails the test proved nothing, so it fails LOUDLY rather than
    // letting the assertion below pass without the race having happened.
    expect(reachedTheInsert).toBe(true);
    expect(outcome).toEqual({ ok: false, status: 409 });
  });

  /**
   * The property, over ordinary concurrency: whichever detection fires, nobody
   * gets a 500 and the index holds. Kept because it is the shape a real client
   * produces, but it is not the guarantee — which path it takes depends on
   * interleaving, so the forced test above is what pins the constraint lane.
   */
  it('ends every racer in success or 409, never a 500', async () => {
    const ownerId = await seedOwner();
    const username = uniqueUsername('race');

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        accountService.createChildAccount(ownerId, ownerId, { kind: 'project', username }),
      ),
    );

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const statuses = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => statusOf(result.reason));

    expect(fulfilled).toHaveLength(1);
    expect(statuses).toEqual(statuses.map(() => 409));

    const rows = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(btrim(${users.username})) = lower(btrim(${username}))`);
    expect(rows).toHaveLength(1);
  });

  /**
   * The translation is by constraint NAME. A `users` write can violate
   * `users_lower_public_key_key` just as easily, and reporting that as "username
   * taken" would send the caller to fix a field that was never the problem —
   * confidently wrong, which is worse than the 500 it replaced.
   */
  it('does not dress a DIFFERENT unique violation up as a taken username', async () => {
    const ownerId = await seedOwner();
    const publicKey = `0x${uniqueUsername('dup')}`;
    await getDb().update(users).set({ publicKey }).where(eq(users.id, ownerId));

    const other = await seedOwner();

    await expect(
      getDb().update(users).set({ publicKey }).where(eq(users.id, other)),
    ).rejects.not.toMatchObject({ statusCode: 409 });
  });
});
