import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { userService } from '../user.service';

beforeAll(async () => {
  await connectPostgres();
});
afterAll(async () => {
  await closePostgres();
});

it('persists every privacy toggle independently without resetting earlier changes', async () => {
  const id = randomUUID().replace(/-/g, '');
  await getDb()
    .insert(users)
    .values({ id, username: `u${id}` });
  const initial = await userService.readPrivacySettings(id);
  if (!initial) throw new Error('Missing test account');
  const expected = { ...initial };
  for (const key of Object.keys(initial) as Array<keyof typeof initial>) {
    expected[key] = !initial[key];
    expect(await userService.updatePrivacySettings(id, { [key]: expected[key] })).toEqual(expected);
    expect(await userService.readPrivacySettings(id)).toEqual(expected);
  }
});
