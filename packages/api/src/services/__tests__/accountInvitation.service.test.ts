import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { accountMembers } from '../../db/schema/accountMembers';
import { accountInvitations } from '../../db/schema/accountInvitations';
import { accountInvitationService as invitations } from '../accountInvitation.service';
import { sendAccountInvitation } from '../accountEmail.mail';

jest.mock('../accountEmail.mail', () => ({ sendAccountInvitation: jest.fn() }));
const send = jest.mocked(sendAccountInvitation);
function lastToken() {
  const token = send.mock.calls.at(-1)?.[1];
  if (!token) throw new Error('Expected an invitation delivery');
  return token;
}
beforeAll(() => connectPostgres());
afterAll(() => closePostgres());
beforeEach(() => send.mockReset());
async function person(kind: 'personal' | 'organization' = 'personal') {
  const [row] = await getDb()
    .insert(users)
    .values({
      kind,
      username: `invite-${randomBytes(8).toString('hex')}`,
      color: 'blue',
      email: `${randomBytes(8).toString('hex')}@example.com`,
    })
    .returning({ id: users.id });
  return row.id;
}
async function fixture() {
  const owner = await person();
  const account = await person('organization');
  const recipient = await person();
  await getDb()
    .insert(accountMembers)
    .values({ accountId: account, memberUserId: owner, role: 'owner' });
  const invitation = await invitations.create(account, owner, {
    email: 'different@example.com',
    role: 'editor',
  });
  const token = lastToken();
  return { owner, account, recipient, invitation, token };
}
const memberRows = (account: string, recipient: string) =>
  getDb()
    .select()
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, account), eq(accountMembers.memberUserId, recipient)));
test('delivery to unknown email and preview grant nothing; a different account can explicitly accept', async () => {
  const f = await fixture();
  expect(await memberRows(f.account, f.recipient)).toEqual([]);
  const preview = await invitations.preview(f.token);
  expect(preview.invitation.email).toBe('different@example.com');
  expect(preview.invitation).not.toHaveProperty('tokenHash');
  expect(await memberRows(f.account, f.recipient)).toEqual([]);
  await invitations.accept(f.token, f.recipient);
  expect(await memberRows(f.account, f.recipient)).toEqual([
    expect.objectContaining({ status: 'active', role: 'editor' }),
  ]);
  await expect(invitations.accept(f.token, f.recipient)).rejects.toThrow(/already used/);
});
test('two simultaneous acceptances create exactly one grant', async () => {
  const f = await fixture();
  const other = await person();
  const results = await Promise.allSettled([
    invitations.accept(f.token, f.recipient),
    invitations.accept(f.token, other),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(
    (await memberRows(f.account, f.recipient)).length + (await memberRows(f.account, other)).length,
  ).toBe(1);
});
test.each(['expired', 'cancelled'] as const)(
  '%s links cannot be previewed or consumed',
  async (status) => {
    const f = await fixture();
    if (status === 'cancelled') await invitations.cancel(f.account, f.owner, f.invitation.id);
    else
      await getDb()
        .update(accountInvitations)
        .set({ expiresAt: new Date(0) })
        .where(eq(accountInvitations.id, f.invitation.id));
    await expect(invitations.preview(f.token)).rejects.toThrow();
    await expect(invitations.accept(f.token, f.recipient)).rejects.toThrow();
    expect(await memberRows(f.account, f.recipient)).toHaveLength(0);
  },
);
test('resend invalidates old link and cancelled invitation cannot be resent', async () => {
  const f = await fixture();
  await invitations.resend(f.account, f.owner, f.invitation.id);
  const replacement = lastToken();
  expect(replacement).not.toBe(f.token);
  await expect(invitations.accept(f.token, f.recipient)).rejects.toThrow();
  await invitations.preview(replacement);
  await invitations.cancel(f.account, f.owner, f.invitation.id);
  await expect(invitations.resend(f.account, f.owner, f.invitation.id)).rejects.toThrow();
});
test('role ceiling checked at issue and again after inviter permissions revoked', async () => {
  const f = await fixture();
  await getDb()
    .update(accountMembers)
    .set({ role: 'admin', permissionRevokes: ['account:act_as'] })
    .where(and(eq(accountMembers.accountId, f.account), eq(accountMembers.memberUserId, f.owner)));
  await expect(
    invitations.create(f.account, f.owner, { email: 'x@example.com', role: 'editor' }),
  ).rejects.toThrow(/cannot grant/);
  await expect(invitations.accept(f.token, f.recipient)).rejects.toThrow(/cannot grant/);
  expect(await memberRows(f.account, f.recipient)).toHaveLength(0);
});
test('existing active memberships are never overwritten or duplicated', async () => {
  const f = await fixture();
  await getDb()
    .insert(accountMembers)
    .values({ accountId: f.account, memberUserId: f.recipient, role: 'admin' });
  await expect(invitations.accept(f.token, f.recipient)).rejects.toThrow(/already has access/);
  expect(await memberRows(f.account, f.recipient)).toEqual([
    expect.objectContaining({ role: 'admin' }),
  ]);
  await invitations.preview(f.token);
});
test('only a personal account can receive membership', async () => {
  const f = await fixture();
  await expect(invitations.accept(f.token, await person('organization'))).rejects.toThrow(
    /personal/,
  );
});
test('resend and cancellation scoped to account and manager', async () => {
  const f = await fixture();
  await expect(invitations.list(f.account, f.recipient)).rejects.toThrow();
  await expect(invitations.resend(f.account, f.recipient, f.invitation.id)).rejects.toThrow();
  await expect(invitations.cancel(f.account, f.recipient, f.invitation.id)).rejects.toThrow();
});

test('parallel independent acceptances do not exhaust the connection pool with nested authorization reads', async () => {
  const fixtures = [];
  for (let i = 0; i < 10; i++) fixtures.push(await fixture());
  await Promise.all(fixtures.map((f) => invitations.accept(f.token, f.recipient)));
});

test('cancellation racing acceptance has one winner and never grants after a successful cancellation', async () => {
  const f = await fixture();
  const [cancel, accept] = await Promise.allSettled([
    invitations.cancel(f.account, f.owner, f.invitation.id),
    invitations.accept(f.token, f.recipient),
  ]);
  expect([cancel, accept].filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(await memberRows(f.account, f.recipient)).toHaveLength(
    cancel.status === 'fulfilled' ? 0 : 1,
  );
});
