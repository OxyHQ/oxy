/**
 * ADR 0066: an Oxy service acts for a person on what its registry entry
 * declares, with no session, task or grant — and only that.
 */
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { insertAccountFixtures } from '../../db/__fixtures__/accountIdentity';
import { accountMembers } from '../../db/schema/accountMembers';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import { firstPartyDelegationActivity } from '../../db/schema/firstPartyDelegationActivity';
import { ALIA_APPLICATION_ID } from '../../config/firstPartyApplications';
import {
  listDelegatedActivity,
  resolveDelegatedRequester,
  UNDECLARED_DELEGATION_MESSAGE,
} from '../firstPartyDelegation.service';

beforeAll(async () => {
  await connectPostgres();
});
afterAll(async () => {
  await closePostgres();
});

/** The Gemies backend's application (it attests as Alia's id until its cut-over). */
async function aliaApplication(ownerAccountId: string): Promise<void> {
  await getDb()
    .insert(applications)
    .values({
      id: ALIA_APPLICATION_ID,
      name: 'Alia',
      ownerAccountId,
      isOfficial: true,
      isInternal: true,
      type: 'internal',
      status: 'active',
      scopes: [],
      capabilities: [],
    })
    .onConflictDoNothing();
}

async function fixture() {
  const [owner, person, stranger, org, bot] = await insertAccountFixtures([
    {},
    {},
    {},
    { kind: 'organization' },
    { kind: 'bot' },
  ]);
  await aliaApplication(owner.id);
  return { owner, person, stranger, org, bot };
}

async function activity(accountId: string) {
  return getDb()
    .select()
    .from(firstPartyDelegationActivity)
    .where(
      and(
        eq(firstPartyDelegationActivity.accountId, accountId),
        eq(firstPartyDelegationActivity.applicationId, ALIA_APPLICATION_ID),
      ),
    );
}

it('acts for a person on a declared receiver with no session or task, and counts every use', async () => {
  const f = await fixture();
  const request = {
    applicationId: ALIA_APPLICATION_ID,
    on: 'oxy:files' as const,
    effect: 'write' as const,
    accountId: f.person.id,
  };
  await expect(resolveDelegatedRequester(request)).resolves.toMatchObject({
    kind: 'delegated',
    principalAccountId: f.person.id,
    subjectAccountId: f.person.id,
  });
  await resolveDelegatedRequester(request);
  const rows = await activity(f.person.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    requesterAccountId: f.person.id,
    receiver: 'oxy:files',
    effect: 'write',
    count: 2,
  });
  // Write includes read.
  await resolveDelegatedRequester({ ...request, effect: 'read' });
  expect(await activity(f.person.id)).toHaveLength(2);
  // The person sees it.
  const listed = await listDelegatedActivity(f.person.id);
  expect(listed.map((row) => row.receiver)).toEqual(['oxy:files', 'oxy:files']);
});

it('refuses what the registry does not declare, and records nothing', async () => {
  const f = await fixture();
  await expect(
    resolveDelegatedRequester({
      applicationId: ALIA_APPLICATION_ID,
      on: 'oxy:privacy',
      effect: 'read',
      accountId: f.person.id,
    }),
  ).rejects.toThrow(UNDECLARED_DELEGATION_MESSAGE);
  await expect(
    resolveDelegatedRequester({
      applicationId: randomUUID(),
      on: 'oxy:files',
      effect: 'read',
      accountId: f.person.id,
    }),
  ).rejects.toThrow(UNDECLARED_DELEGATION_MESSAGE);
  expect(await activity(f.person.id)).toHaveLength(0);
});

it('acts on an account the person does not own only while they operate it', async () => {
  const f = await fixture();
  const onOrg = {
    applicationId: ALIA_APPLICATION_ID,
    on: 'oxy:tools' as const,
    effect: 'write' as const,
    accountId: f.org.id,
    requesterAccountId: f.person.id,
  };
  await expect(resolveDelegatedRequester(onOrg)).rejects.toThrow(
    'The person does not operate this account.',
  );
  // Naming the org alone never makes the org the person.
  await expect(
    resolveDelegatedRequester({ ...onOrg, requesterAccountId: undefined }),
  ).rejects.toThrow('The account is not available.');
  await getDb().insert(accountMembers).values({
    accountId: f.org.id,
    memberUserId: f.person.id,
    role: 'admin',
    inherit: true,
    status: 'active',
  });
  await expect(resolveDelegatedRequester(onOrg)).resolves.toMatchObject({
    principalAccountId: f.person.id,
    subjectAccountId: f.org.id,
  });
  // Another person still cannot reach it.
  await expect(
    resolveDelegatedRequester({ ...onOrg, requesterAccountId: f.stranger.id }),
  ).rejects.toThrow('The person does not operate this account.');
});

it('never treats a bot as the person, and checks accounts live', async () => {
  const f = await fixture();
  await expect(
    resolveDelegatedRequester({
      applicationId: ALIA_APPLICATION_ID,
      on: 'oxy:tools',
      effect: 'write',
      accountId: f.bot.id,
    }),
  ).rejects.toThrow('The account is not available.');
  await getDb().update(users).set({ accountStatus: 'archived' }).where(eq(users.id, f.person.id));
  await expect(
    resolveDelegatedRequester({
      applicationId: ALIA_APPLICATION_ID,
      on: 'oxy:files',
      effect: 'read',
      accountId: f.person.id,
    }),
  ).rejects.toThrow('The account is not available.');
});
