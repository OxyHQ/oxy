import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../schema/users';
import { listPostalAddresses, savePostalAddress, deletePostalAddress } from '../postalAddresses';

beforeAll(async () => {
  await connectPostgres();
});
afterAll(async () => {
  await closePostgres();
});
async function account() {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `address-${randomUUID()}` })
    .returning({ id: users.id });
  if (!row) throw new Error('Missing test account');
  return row.id;
}
const input = {
  recipientName: 'Private Recipient',
  line1: '1 Road',
  city: 'Dublin',
  postalCode: '',
  country: 'IE',
};
describe('private account postal destinations', () => {
  it('scopes every read/write/delete to its owner and preserves another account default', async () => {
    const [a, b] = await Promise.all([account(), account()]);
    const saved = await savePostalAddress(a, { ...input, isDefault: true });
    await savePostalAddress(b, { ...input, isDefault: true });
    expect(await listPostalAddresses(b)).not.toContainEqual(saved);
    await expect(savePostalAddress(b, { isDefault: true }, saved.id)).rejects.toThrow(
      'Address not found',
    );
    await expect(deletePostalAddress(b, saved.id)).rejects.toThrow('Address not found');
    expect((await listPostalAddresses(a))[0]).toEqual(saved);
    expect((await listPostalAddresses(b))[0]?.isDefault).toBe(true);
  });
  it('serializes concurrent default changes and never guesses a replacement after deletion', async () => {
    const a = await account();
    const addresses = await Promise.all([
      savePostalAddress(a, input),
      savePostalAddress(a, { ...input, line1: '2 Road' }),
    ]);
    expect((await listPostalAddresses(a)).every((row) => !row.isDefault)).toBe(true);
    await Promise.all(addresses.map((row) => savePostalAddress(a, { isDefault: true }, row.id)));
    const defaults = (await listPostalAddresses(a)).filter((row) => row.isDefault);
    expect(defaults).toHaveLength(1);
    const first = defaults[0];
    if (!first) throw new Error('Missing default');
    await deletePostalAddress(a, first.id);
    expect((await listPostalAddresses(a)).every((row) => !row.isDefault)).toBe(true);
  });
});

it('clears private optional fields explicitly without replacing required destination fields', async () => {
  const owner = await account();
  const saved = await savePostalAddress(owner, {
    ...input,
    phone: '+123456789',
    label: 'Home',
    line2: 'Unit 2',
    region: 'County',
  });
  const changed = await savePostalAddress(
    owner,
    { phone: null, label: null, line2: null, region: null },
    saved.id,
  );
  expect(changed.recipientName).toBe(input.recipientName);
  for (const field of ['phone', 'label', 'line2', 'region'])
    expect(changed).not.toHaveProperty(field);
});
it('bounds the address book under the same lock used by concurrent creates', async () => {
  const owner = await account();
  for (let i = 0; i < 99; i++) await savePostalAddress(owner, { ...input, line1: `${i} Road` });
  const attempts = await Promise.allSettled([
    savePostalAddress(owner, { ...input, line1: 'Final A' }),
    savePostalAddress(owner, { ...input, line1: 'Final B' }),
  ]);
  expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect(await listPostalAddresses(owner)).toHaveLength(100);
});
