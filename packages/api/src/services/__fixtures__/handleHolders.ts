import { sql } from 'drizzle-orm';
import { getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';

/**
 * Make sure an account holds each handle — a user federation key is minted only
 * for one — and return the holders' ids in order. Idempotent, because test files
 * sharing a worker database reuse handles.
 */
export async function holdHandles(...handles: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const handle of handles) {
    await getDb().insert(users).values({ username: handle }).onConflictDoNothing();
    const [row] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(btrim(${users.username})) = lower(btrim(${handle}))`)
      .limit(1);
    if (!row) throw new Error(`no account holds ${handle}`);
    ids.push(row.id);
  }
  return ids;
}
