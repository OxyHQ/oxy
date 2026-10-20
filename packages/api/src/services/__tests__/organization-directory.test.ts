import { createAccountSchema, updateAccountSchema } from '../../schemas/account.schemas';
import { userService } from '../user.service';
import { hasOrganizationOperatingAuthority } from '../organizationAuthority.service';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import {
  users,
  organizationProfiles,
  accountMembers,
  organizationDirectoryAudit,
} from '../../db/schema';
import { accountService } from '../account.service';
import * as directory from '../organization-directory.service';

beforeAll(async () => {
  await connectPostgres();
});
afterAll(async () => {
  await closePostgres();
});
async function person() {
  const [row] = await getDb()
    .insert(users)
    .values({ kind: 'personal', username: `person${randomUUID().slice(0, 8)}` })
    .returning({ id: users.id });
  if (!row) throw new Error('Missing fixture');
  return row.id;
}
const company = (name = '3M') => ({ name, organizationType: 'business' as const });
describe('canonical organization directory', () => {
  it.each(['3M', '7-Eleven', 'AT&T'])(
    'preserves real organization name %s on the shared account',
    async (name) => {
      const organization = await directory.createNeutralOrganization(company(name));
      expect(organization).toMatchObject({
        name,
        organizationType: 'business',
        claimStatus: 'unclaimed',
        verifiedDomains: [],
      });
      const [identity] = await getDb()
        .select({ name: users.nameDisplay, kind: users.kind, parent: users.parentAccountId })
        .from(users)
        .where(eq(users.id, organization.accountId));
      expect(identity).toEqual({ name, kind: 'organization', parent: null });
      expect(
        await accountService.resolveEffectiveAccess(await person(), organization.accountId),
      ).toBeNull();
    },
  );
  it('blocks membership, credentials, tree and application authority for unclaimed identities at the database', async () => {
    const organization = await directory.createNeutralOrganization(company());
    const owner = await person();
    await expect(
      getDb().insert(accountMembers).values({
        accountId: organization.accountId,
        memberUserId: owner,
        role: 'owner',
        status: 'active',
      }),
    ).rejects.toThrow();
    await expect(
      getDb()
        .update(users)
        .set({ email: 'takeover@example.test' })
        .where(eq(users.id, organization.accountId)),
    ).rejects.toThrow();
    await expect(
      getDb()
        .update(users)
        .set({ parentAccountId: owner })
        .where(eq(users.id, organization.accountId)),
    ).rejects.toThrow();
    await expect(
      getDb().insert(users).values({ kind: 'project', parentAccountId: organization.accountId }),
    ).rejects.toThrow();
    await expect(
      getDb().execute(
        sql`insert into user_passwords(user_id, password_hash) values (${organization.accountId}, '$scrypt$test')`,
      ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        code: '23514',
        message: 'organization has no operating authority',
      }),
    });
  });
  it('requires independent approval before granting owner authority to the existing ID', async () => {
    const organization = await directory.createNeutralOrganization(company());
    const owner = await person(),
      reviewer = await person();
    const claim = await directory.submitOrganizationClaim(
      organization.accountId,
      owner,
      'review/private-case',
    );
    expect(await accountService.resolveEffectiveAccess(owner, organization.accountId)).toBeNull();
    await expect(
      directory.reviewOrganizationClaim(claim.id, owner, 'approved', 'self'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await directory.reviewOrganizationClaim(claim.id, reviewer, 'approved', 'staff-reviewed-case');
    expect((await directory.getOrganization(organization.accountId)).claimStatus).toBe('claimed');
    expect((await accountService.resolveEffectiveAccess(owner, organization.accountId))?.role).toBe(
      'owner',
    );
    await expect(
      directory.reviewOrganizationClaim(claim.id, reviewer, 'approved', 'replay'),
    ).rejects.toMatchObject({ code: 'conflict' });
    const audit = await getDb()
      .select({ action: organizationDirectoryAudit.action })
      .from(organizationDirectoryAudit)
      .where(eq(organizationDirectoryAudit.accountId, organization.accountId));
    expect(audit).toEqual([{ action: 'claim_approved' }]);
  });
  it('admits only one of concurrent claim approvals', async () => {
    const organization = await directory.createNeutralOrganization(company());
    const reviewer = await person();
    const a = await directory.submitOrganizationClaim(organization.accountId, await person(), 'a');
    const b = await directory.submitOrganizationClaim(organization.accountId, await person(), 'b');
    const results = await Promise.allSettled([
      directory.reviewOrganizationClaim(a.id, reviewer, 'approved', 'review-a'),
      directory.reviewOrganizationClaim(b.id, reviewer, 'approved', 'review-b'),
    ]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
  });
  it('imports idempotently without name matching or claiming ownership', async () => {
    const actor = await person();
    const input = {
      namespace: 'mercaria',
      externalId: randomUUID(),
      organization: company(),
      evidenceReference: 'immutable-archive/sha256',
    };
    const [a, b] = await Promise.all([
      directory.importOrganizationExternal(input, actor),
      directory.importOrganizationExternal(input, actor),
    ]);
    expect(a.accountId).toBe(b.accountId);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect((await directory.getOrganization(a.accountId)).claimStatus).toBe('unclaimed');
    const separate = await directory.importOrganizationExternal(
      { ...input, externalId: randomUUID() },
      actor,
    );
    expect(separate.accountId).not.toBe(a.accountId);
  });
  it('resolves neutral merge chains and batch missing IDs without transferring authority', async () => {
    const a = await directory.createNeutralOrganization(company('Alpha'));
    const b = await directory.createNeutralOrganization(company('Beta'));
    const c = await directory.createNeutralOrganization(company('Gamma'));
    const reviewer = await person();
    await directory.mergeOrganizations(a.accountId, b.accountId, reviewer, 'source-evidence');
    await directory.mergeOrganizations(b.accountId, c.accountId, reviewer, 'source-evidence');
    const result = await directory.batchOrganizations([
      a.accountId,
      b.accountId,
      c.accountId,
      'missing',
    ]);
    expect(result.items.map((item) => item.organization.accountId)).toEqual([
      c.accountId,
      c.accountId,
      c.accountId,
    ]);
    expect(result.missingIds).toEqual(['missing']);
    expect(await accountService.resolveEffectiveAccess(reviewer, a.accountId)).toBeNull();
    const claim = await directory.submitOrganizationClaim(c.accountId, await person(), 'claim');
    await directory.reviewOrganizationClaim(claim.id, reviewer, 'approved', 'review');
    await expect(
      directory.mergeOrganizations(c.accountId, a.accountId, reviewer, 'unsafe'),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('does not expose private organizations and binds search cursors to filters', async () => {
    const prefix = `Directory${randomUUID().slice(0, 8)}`;
    const a = await directory.createNeutralOrganization(company(`${prefix}A`));
    await directory.createNeutralOrganization(company(`${prefix}B`));
    const page = await directory.searchOrganizations({ query: prefix, limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const next = await directory.searchOrganizations({
      query: prefix,
      limit: 1,
      cursor: page.nextCursor ?? undefined,
    });
    expect(next.items).toHaveLength(1);
    expect(next.items[0]?.accountId).not.toBe(page.items[0]?.accountId);
    await expect(
      directory.searchOrganizations({ query: 'different', cursor: page.nextCursor ?? undefined }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await getDb()
      .update(users)
      .set({ privacyIsPrivateAccount: true })
      .where(eq(users.id, a.accountId));
    expect((await directory.batchOrganizations([a.accountId])).missingIds).toEqual([a.accountId]);
  });
  it('creates managed organizations atomically with subtype and real authority, retaining company punctuation on edits', async () => {
    const owner = await person();
    const result = await accountService.createChildAccount(owner, owner, {
      kind: 'organization',
      username: `company${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      name: { displayName: '7-Eleven' },
      organizationType: 'business',
    });
    expect(await directory.getOrganization(result.account.id)).toMatchObject({
      claimStatus: 'claimed',
      organizationType: 'business',
      name: '7-Eleven',
    });
    await accountService.updateAccount(result.account.id, {
      name: { displayName: 'AT&T' },
      organizationType: 'community',
    });
    expect(await directory.getOrganization(result.account.id)).toMatchObject({
      name: 'AT&T',
      organizationType: 'community',
    });
    expect((await accountService.resolveEffectiveAccess(owner, result.account.id))?.role).toBe(
      'owner',
    );
    await expect(
      accountService.updateAccount(owner, { organizationType: 'business' }),
    ).rejects.toThrow('organization account');
  });
  it('uses the same title policy through account routes and direct profile edits', async () => {
    const owner = await person();
    const name = `3M & ${'A'.repeat(295)}`;
    const input = createAccountSchema.parse({
      kind: 'organization',
      username: `long${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      name: { displayName: name },
      organizationType: 'business',
    });
    const result = await accountService.createChildAccount(owner, owner, input);
    expect((await directory.getOrganization(result.account.id)).name).toBe(name);
    await accountService.updateAccount(
      result.account.id,
      updateAccountSchema.parse({ name: { displayName: `7-Eleven ${'B'.repeat(291)}` } }),
    );
    expect((await directory.getOrganization(result.account.id)).name).toBe(
      `7-Eleven ${'B'.repeat(291)}`,
    );
    for (const displayName of ['3M', '7-Eleven', 'AT&T', name]) {
      await userService.updateUserProfile(result.account.id, { name: { displayName } });
      expect((await directory.getOrganization(result.account.id)).name).toBe(displayName);
    }
    for (const displayName of ['A'.repeat(301), '<Company>', 'Company\u0000']) {
      await expect(
        accountService.updateAccount(result.account.id, { name: { displayName } }),
      ).rejects.toThrow();
      await expect(
        userService.updateUserProfile(result.account.id, { name: { displayName } }),
      ).rejects.toThrow();
    }
    await expect(
      userService.updateUserProfile(owner, { name: { displayName: 'AT&T' } }),
    ).rejects.toThrow();
    await expect(
      accountService.updateAccount(owner, { name: { displayName: 'A'.repeat(101) } }),
    ).rejects.toThrow();
  });
  it('allows disabling existing membership after an organization becomes inactive', async () => {
    const owner = await person(),
      reviewer = await person();
    const org = await directory.createNeutralOrganization(company());
    const claim = await directory.submitOrganizationClaim(org.accountId, owner, 'proof');
    await directory.reviewOrganizationClaim(claim.id, reviewer, 'approved', 'review');
    await getDb()
      .update(organizationProfiles)
      .set({ status: 'inactive' })
      .where(eq(organizationProfiles.accountId, org.accountId));
    expect(await accountService.resolveEffectiveAccess(owner, org.accountId)).toBeNull();
    await getDb()
      .update(accountMembers)
      .set({ status: 'removed' })
      .where(eq(accountMembers.accountId, org.accountId));
    await expect(
      getDb()
        .update(accountMembers)
        .set({ status: 'active' })
        .where(eq(accountMembers.accountId, org.accountId)),
    ).rejects.toThrow();
  });
  it('keeps claim evidence private and binds claim cursors to the claimant', async () => {
    const owner = await person(),
      stranger = await person(),
      org = await directory.createNeutralOrganization(company());
    const claim = await directory.submitOrganizationClaim(org.accountId, owner, 'private-case');
    expect(await directory.submitOrganizationClaim(org.accountId, owner, 'retry')).toEqual(claim);
    expect((await directory.listOrganizationClaims(owner, {})).items).toEqual([
      expect.objectContaining({ id: claim.id, evidenceReference: 'private-case' }),
    ]);
    expect((await directory.listOrganizationClaims(stranger, {})).items).toEqual([]);
    await expect(directory.getOrganizationClaim(claim.id, stranger)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await directory.getOrganizationClaim(claim.id, null)).toMatchObject({
      evidenceReference: 'private-case',
    });
  });
  it('serializes claim creation against merge so a pending claim cannot be attached after a merge', async () => {
    const owner = await person(),
      reviewer = await person();
    const source = await directory.createNeutralOrganization(company()),
      target = await directory.createNeutralOrganization(company());
    const results = await Promise.allSettled([
      directory.submitOrganizationClaim(source.accountId, owner, 'claim'),
      directory.mergeOrganizations(source.accountId, target.accountId, reviewer, 'merge'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });
  it('searches canonical legal names and aliases and updates projection when shared identity is renamed', async () => {
    const marker = `Legal${randomUUID().slice(0, 8)}`;
    const org = await directory.createNeutralOrganization({
      ...company('Unrelated'),
      legalName: `${marker} Corporation`,
      aliases: [{ alias: `${marker} Alias`, kind: 'former_name' }],
    });
    expect(
      (await directory.searchOrganizations({ query: `${marker} Corp` })).items.map(
        (item) => item.accountId,
      ),
    ).toContain(org.accountId);
    expect(
      (await directory.searchOrganizations({ query: `${marker} Alias` })).items.map(
        (item) => item.accountId,
      ),
    ).toContain(org.accountId);
    await getDb()
      .update(users)
      .set({ nameDisplay: `${marker} New` })
      .where(eq(users.id, org.accountId));
    expect(
      (await directory.searchOrganizations({ query: `${marker} New` })).items.map(
        (item) => item.accountId,
      ),
    ).toContain(org.accountId);
  });
  it('writes the same rows for one neutral organization and for an imported one', async () => {
    const organization = {
      name: `Same Shape ${randomUUID().slice(0, 8)}`,
      organizationType: 'nonprofit' as const,
      legalName: 'Same Shape Foundation',
      websiteUrl: 'https://same-shape.example',
      countryCode: 'ES',
    };
    const created = await directory.createNeutralOrganization(organization);
    const imported = await directory.importOrganizationBatch(
      {
        namespace: `test_${randomUUID().replace(/-/g, '')}`,
        items: [{ externalId: 'one', organization, evidenceReference: 'source/proof' }],
      },
      { applicationId: randomUUID(), ownerAccountId: await person() },
    );
    const importedId = imported.items[0]?.accountId;
    if (!importedId) throw new Error('Missing import result');
    const shape = async (accountId: string) => {
      const [row] = await getDb()
        .select({
          username: users.username,
          kind: users.kind,
          type: users.type,
          nameDisplay: users.nameDisplay,
          avatar: users.avatar,
          verified: users.verified,
          parentAccountId: users.parentAccountId,
          rootAccountId: users.rootAccountId,
          privacyIsPrivateAccount: users.privacyIsPrivateAccount,
          organizationType: organizationProfiles.organizationType,
          legalName: organizationProfiles.legalName,
          websiteUrl: organizationProfiles.websiteUrl,
          countryCode: organizationProfiles.countryCode,
          aliases: organizationProfiles.aliases,
          claimStatus: organizationProfiles.claimStatus,
          status: organizationProfiles.status,
        })
        .from(users)
        .innerJoin(organizationProfiles, eq(organizationProfiles.accountId, users.id))
        .where(eq(users.id, accountId));
      if (!row) throw new Error('Missing organization rows');
      const { username, ...rest } = row;
      expect(username).toMatch(/^org[0-9a-f]{20}$/);
      return rest;
    };
    expect(await shape(importedId)).toEqual(await shape(created.accountId));
  });
  it('bulk imports neutral identities idempotently without mutating existing names', async () => {
    const actor = { applicationId: randomUUID(), ownerAccountId: await person() };
    const namespace = `test_${randomUUID().replace(/-/g, '')}`;
    const input = {
      namespace,
      items: Array.from({ length: 100 }, (_, index) => ({
        externalId: String(index),
        organization: company(`Company ${index}`),
        evidenceReference: 'source/proof',
      })),
    };
    const [first, retry] = await Promise.all([
      directory.importOrganizationBatch(input, actor),
      directory.importOrganizationBatch(input, actor),
    ]);
    expect(first.items.map((item) => item.accountId)).toEqual(
      retry.items.map((item) => item.accountId),
    );
    expect([...first.items, ...retry.items].filter((item) => item.created)).toHaveLength(100);
    const existing = first.items[0];
    if (!existing) throw new Error('Missing batch fixture');
    const repeated = await directory.importOrganizationBatch(
      {
        namespace,
        items: [
          {
            ...input.items[0],
            externalId: '0',
            organization: company('Changed'),
            evidenceReference: 'new-proof',
          },
        ],
      },
      actor,
    );
    expect(repeated.items[0]).toEqual({ ...existing, created: false });
    expect((await directory.getOrganization(existing.accountId)).name).toBe('Company 0');
    expect(
      await accountService.resolveEffectiveAccess(actor.ownerAccountId, existing.accountId),
    ).toBeNull();
  });
  it('curates neutral facts and suppression without granting ownership or leaking through generic public profiles', async () => {
    const reviewer = await person(),
      org = await directory.createNeutralOrganization(company('Typo'));
    await directory.curateOrganization(
      org.accountId,
      { changes: { name: '3M', organizationType: 'nonprofit' }, evidenceReference: 'correction' },
      reviewer,
    );
    expect(await directory.getOrganization(org.accountId)).toMatchObject({
      name: '3M',
      organizationType: 'nonprofit',
      claimStatus: 'unclaimed',
    });
    expect(await hasOrganizationOperatingAuthority(org.accountId)).toBe(false);
    await directory.curateOrganization(
      org.accountId,
      { status: 'suppressed', evidenceReference: 'moderation' },
      reviewer,
    );
    expect(await userService.getPublicUserById(org.accountId)).toBeNull();
    expect(await userService.getUsersByIds([org.accountId])).toEqual([]);
    await expect(directory.getOrganization(org.accountId)).rejects.toMatchObject({
      code: 'not_found',
    });
    await directory.curateOrganization(
      org.accountId,
      { status: 'active', evidenceReference: 'review' },
      reviewer,
    );
    expect(await directory.getOrganization(org.accountId)).toMatchObject({
      name: '3M',
      claimStatus: 'unclaimed',
    });
  });
  it('refuses a bare organization insert without its profile in the same transaction', async () => {
    await expect(getDb().insert(users).values({ kind: 'organization' })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: '23514' }),
    });
  });
  it('finds canonical targets by former source names after repeated merges without leaking hidden targets', async () => {
    const prefix = `Former${randomUUID().slice(0, 8)}`,
      reviewer = await person();
    const first = await directory.createNeutralOrganization(company(prefix));
    const second = await directory.createNeutralOrganization(company(`Next ${prefix}`));
    const target = await directory.createNeutralOrganization(company(`Final ${prefix}`));
    await directory.mergeOrganizations(first.accountId, second.accountId, reviewer, 'proof');
    await directory.mergeOrganizations(second.accountId, target.accountId, reviewer, 'proof');
    expect(
      (await directory.searchOrganizations({ query: prefix })).items.map((item) => item.accountId),
    ).toEqual([target.accountId]);
    await directory.curateOrganization(
      target.accountId,
      { status: 'suppressed', evidenceReference: 'review' },
      reviewer,
    );
    expect((await directory.searchOrganizations({ query: prefix })).items).toEqual([]);
    await directory.curateOrganization(
      target.accountId,
      { status: 'active', evidenceReference: 'review' },
      reviewer,
    );
    await getDb()
      .update(users)
      .set({ privacyIsPrivateAccount: true })
      .where(eq(users.id, target.accountId));
    expect((await directory.searchOrganizations({ query: prefix })).items).toEqual([]);
  });
});
