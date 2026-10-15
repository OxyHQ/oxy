import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { blocks } from '../../db/schema/blocks';
import { decideProfileAccess } from '../profileAccess.service';
beforeAll(async () => {
  await connectPostgres();
});
afterAll(async () => {
  await closePostgres();
});
async function person(isPrivate = false) {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `access${randomUUID()}`, privacyIsPrivateAccount: isPrivate })
    .returning({ id: users.id });
  return row.id;
}
it('permits public detail anonymously and private detail only to its authenticated owner', async () => {
  const subject = await person(),
    viewer = await person();
  expect(await decideProfileAccess(subject, null)).toEqual({
    allowed: true,
    reason: 'public',
    policyVersion: '1',
  });
  await getDb().update(users).set({ privacyIsPrivateAccount: true }).where(eq(users.id, subject));
  expect(await decideProfileAccess(subject, null)).toMatchObject({
    allowed: false,
    reason: 'private',
  });
  expect(await decideProfileAccess(subject, viewer)).toMatchObject({
    allowed: false,
    reason: 'private',
  });
  expect(await decideProfileAccess(subject, subject)).toMatchObject({
    allowed: true,
    reason: 'owner',
  });
});
it('honors both block directions, the profile visibility toggle, and erased/missing subjects', async () => {
  const subject = await person(),
    viewer = await person();
  await getDb().insert(blocks).values({ userId: subject, blockedId: viewer });
  expect(await decideProfileAccess(subject, viewer)).toMatchObject({
    allowed: false,
    reason: 'blocked',
  });
  expect(await decideProfileAccess(viewer, subject)).toMatchObject({
    allowed: false,
    reason: 'blocked',
  });
  await getDb().update(users).set({ privacyProfileVisibility: false }).where(eq(users.id, subject));
  expect(await decideProfileAccess(subject, null)).toMatchObject({
    allowed: false,
    reason: 'private',
  });
  await getDb().update(users).set({ accountStatus: 'archived' }).where(eq(users.id, subject));
  expect(await decideProfileAccess(subject, subject)).toMatchObject({
    allowed: false,
    reason: 'unavailable',
  });
  expect(await decideProfileAccess('missing', null)).toMatchObject({
    allowed: false,
    reason: 'unavailable',
  });
});
