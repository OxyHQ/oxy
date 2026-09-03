import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../postgres';
import type { PlatformScopeWriteRolloutGuard } from '../inferencePlatformScopeWriteGate';
import { inferencePublishers } from '../../db/schema';

beforeAll(connectPostgres);
afterAll(closePostgres);

describe('the platform-internal pre-commit rollout fence', () => {
  it('rolls back catalogue writes when the final live ECS proof fails', async () => {
    const slug = `rollback${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const rolloutChanged = new Error('live ECS rollout changed before commit');
    const guard: PlatformScopeWriteRolloutGuard = {
      assertStillComplete: jest.fn(async () => {
        throw rolloutChanged;
      }),
      close: jest.fn(),
    };

    await expect(
      getDb().transaction(async (tx) => {
        await tx.insert(inferencePublishers).values({
          slug,
          displayName: 'Rollback fixture',
        });
        await guard.assertStillComplete();
      }),
    ).rejects.toBe(rolloutChanged);

    const rows = await getDb()
      .select({ slug: inferencePublishers.slug })
      .from(inferencePublishers)
      .where(eq(inferencePublishers.slug, slug));
    expect(rows).toEqual([]);
    expect(guard.assertStillComplete).toHaveBeenCalledTimes(1);
  });
});
