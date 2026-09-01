/**
 * attribution.service tests — against a REAL Postgres.
 *
 * The four resolutions this suite protects are authorization and BILLING
 * decisions, and every property worth protecting here is a property of stored
 * rows: which account owns an application, whether a membership cascades down a
 * project subtree, whether a per-member revoke actually takes a permission away,
 * and whether a billing profile row exists at all. An emulator could only assert
 * which calls the service makes.
 *
 * The whole run shares one database, so every test mints its own accounts and
 * scopes every assertion to ids it owns.
 */

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountMembers } from '../../db/schema/accountMembers';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { userAncestors } from '../../db/schema/userAncestors';
import { userCredits } from '../../db/schema/userCredits';
import { users } from '../../db/schema/users';
import type { AccountRole } from '../../utils/accountRoles';
import {
  callerMayReadApplicationBalance,
  resolveAccountBillingProfile,
  resolveApplicationBillingProfile,
  resolveApplicationOwnerAccount,
  resolveCallerAccountAccess,
  resolveCallerApplicationAccess,
  resolveCredentialAttribution,
} from '../attribution.service';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

// ===========================================================================
// Fixtures
// ===========================================================================

let seedCounter = 0;
function uniqueSuffix(): string {
  seedCounter += 1;
  return `${seedCounter}z${Date.now().toString(36)}`;
}

type SeedKind = 'personal' | 'organization' | 'project' | 'bot' | 'channel';

async function seedAccount(
  options: {
    kind?: SeedKind;
    parentAccountId?: string;
    rootAccountId?: string;
    /** Root FIRST, matching `user_ancestors.depth` ordering. */
    ancestors?: string[];
    accountStatus?: 'active' | 'archived';
  } = {}
): Promise<string> {
  const [account] = await getDb()
    .insert(users)
    .values({
      color: 'teal',
      kind: options.kind ?? 'personal',
      username: `attrib${uniqueSuffix()}`,
      parentAccountId: options.parentAccountId,
      rootAccountId: options.rootAccountId,
      accountStatus: options.accountStatus ?? 'active',
    })
    .returning({ id: users.id });

  const ancestors = options.ancestors ?? [];
  if (ancestors.length > 0) {
    await getDb()
      .insert(userAncestors)
      .values(ancestors.map((ancestorId, depth) => ({ userId: account.id, ancestorId, depth })));
  }
  return account.id;
}

async function seedMember(
  accountId: string,
  memberUserId: string,
  role: AccountRole,
  extra: {
    inherit?: boolean;
    status?: 'active' | 'invited' | 'removed';
    permissionGrants?: string[];
    permissionRevokes?: string[];
  } = {}
): Promise<string> {
  const [row] = await getDb()
    .insert(accountMembers)
    .values({
      accountId,
      memberUserId,
      role,
      inherit: extra.inherit ?? true,
      status: extra.status ?? 'active',
      permissionGrants: extra.permissionGrants ?? [],
      permissionRevokes: extra.permissionRevokes ?? [],
      joinedAt: new Date(),
    })
    .returning({ id: accountMembers.id });
  return row.id;
}

async function seedApplication(
  ownerAccountId: string,
  options: { status?: 'active' | 'suspended' | 'deleted' | 'pending_review'; scopes?: string[] } = {}
): Promise<string> {
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: `Attrib App ${uniqueSuffix()}`,
      ownerAccountId,
      status: options.status ?? 'active',
      scopes: options.scopes ?? [],
    })
    .returning({ id: applications.id });
  return app.id;
}

async function seedCredential(
  applicationId: string,
  options: {
    status?: 'active' | 'deprecated' | 'revoked';
    expiresAt?: Date | null;
    scopes?: string[];
    type?: 'public' | 'confidential' | 'service';
  } = {}
): Promise<{ id: string; publicKey: string }> {
  const publicKey = `oxy_dk_attrib${uniqueSuffix()}`;
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId,
      name: `cred ${uniqueSuffix()}`,
      publicKey,
      type: options.type ?? 'service',
      environment: 'production',
      status: options.status ?? 'active',
      expiresAt: options.expiresAt ?? null,
      scopes: options.scopes ?? [],
    })
    .returning({ id: applicationCredentials.id });
  return { id: credential.id, publicKey };
}

async function seedBillingProfile(
  accountId: string,
  values: { creditsFree?: number; creditsPaid?: number; stripeCustomerId?: string } = {}
): Promise<void> {
  await getDb()
    .insert(userCredits)
    .values({
      userId: accountId,
      creditsFree: values.creditsFree ?? 1000,
      creditsPaid: values.creditsPaid ?? 0,
      stripeCustomerId: values.stripeCustomerId,
    });
}

// ===========================================================================
// 1. application → owner account
// ===========================================================================

describe('resolveApplicationOwnerAccount', () => {
  it('resolves a PERSONAL-owned application to the owning personal account', async () => {
    const person = await seedAccount({ kind: 'personal' });
    const appId = await seedApplication(person);

    const result = await resolveApplicationOwnerAccount(appId);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.application.ownerAccountId).toBe(person);
    expect(result.application.ownerAccountKind).toBe('personal');
    expect(result.application.applicationId).toBe(appId);
  });

  it('resolves an ORGANIZATION-owned application to the organization, not its creator', async () => {
    const founder = await seedAccount({ kind: 'personal' });
    const org = await seedAccount({ kind: 'organization' });
    await seedMember(org, founder, 'owner');
    const appId = await seedApplication(org);

    const result = await resolveApplicationOwnerAccount(appId);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.application.ownerAccountId).toBe(org);
    expect(result.application.ownerAccountKind).toBe('organization');
    // The distinction that matters: the human who set it up is NOT the
    // responsible principal.
    expect(result.application.ownerAccountId).not.toBe(founder);
  });

  it('resolves a PROJECT-owned application to the project, not to its parent organization', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const project = await seedAccount({
      kind: 'project',
      parentAccountId: org,
      rootAccountId: org,
      ancestors: [org],
    });
    const appId = await seedApplication(project);

    const result = await resolveApplicationOwnerAccount(appId);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.application.ownerAccountId).toBe(project);
    expect(result.application.ownerAccountKind).toBe('project');
    expect(result.application.ownerAccountId).not.toBe(org);
  });

  it('reports an unknown application rather than throwing or answering null', async () => {
    const result = await resolveApplicationOwnerAccount('01a00000-0000-7000-8000-000000000000');
    expect(result).toEqual({
      status: 'unknown-application',
      applicationId: '01a00000-0000-7000-8000-000000000000',
    });
  });

  it('carries the status of a soft-deleted application instead of hiding it', async () => {
    const person = await seedAccount();
    const appId = await seedApplication(person, { status: 'deleted' });

    const result = await resolveApplicationOwnerAccount(appId);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.application.applicationStatus).toBe('deleted');
    expect(result.application.ownerAccountId).toBe(person);
  });
});

// ===========================================================================
// 2. credential → application → owner account
// ===========================================================================

describe('resolveCredentialAttribution', () => {
  it('resolves a client id through its application to the owning organization', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const appId = await seedApplication(org, { scopes: ['user:read', 'files:write'] });
    const credential = await seedCredential(appId, { scopes: ['user:read'] });

    const result = await resolveCredentialAttribution(credential.publicKey);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.attribution.credentialId).toBe(credential.id);
    expect(result.attribution.credentialPublicKey).toBe(credential.publicKey);
    // Both scope sets travel, because a credential's effective authority is
    // their intersection and a consumer holding one of them would have to
    // re-read the other.
    expect(result.attribution.credentialScopes).toEqual(['user:read']);
    expect(result.attribution.applicationScopes).toEqual(['user:read', 'files:write']);
    expect(result.attribution.application.applicationId).toBe(appId);
    expect(result.attribution.application.ownerAccountId).toBe(org);
    expect(result.attribution.application.ownerAccountKind).toBe('organization');
  });

  it('never returns secret material', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const appId = await seedApplication(org);
    const credential = await seedCredential(appId);

    const result = await resolveCredentialAttribution(credential.publicKey);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(Object.keys(result.attribution)).not.toContain('secretHash');
    expect(JSON.stringify(result)).not.toContain('secretHash');
  });

  it('reports an unknown client id', async () => {
    const result = await resolveCredentialAttribution('oxy_dk_does_not_exist');
    expect(result).toEqual({ status: 'unknown-credential', clientId: 'oxy_dk_does_not_exist' });
  });

  it('refuses a REVOKED credential but still names the application it belonged to', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const appId = await seedApplication(org);
    const credential = await seedCredential(appId, { status: 'revoked' });

    const result = await resolveCredentialAttribution(credential.publicKey);

    expect(result.status).toBe('unusable-credential');
    if (result.status !== 'unusable-credential') return;
    expect(result.credentialStatus).toBe('revoked');
    expect(result.credentialId).toBe(credential.id);
    expect(result.applicationId).toBe(appId);
  });

  it('accepts a DEPRECATED credential inside its rotation grace window', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const appId = await seedApplication(org);
    const credential = await seedCredential(appId, {
      status: 'deprecated',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const result = await resolveCredentialAttribution(credential.publicKey);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.attribution.application.ownerAccountId).toBe(org);
  });

  it('refuses a DEPRECATED credential whose grace window has closed', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const appId = await seedApplication(org);
    const credential = await seedCredential(appId, {
      status: 'deprecated',
      expiresAt: new Date(Date.now() - 60 * 1000),
    });

    const result = await resolveCredentialAttribution(credential.publicKey);

    expect(result.status).toBe('unusable-credential');
    if (result.status !== 'unusable-credential') return;
    expect(result.credentialStatus).toBe('deprecated');
  });
});

// ===========================================================================
// 3. caller → effective account role
// ===========================================================================

describe('resolveCallerAccountAccess', () => {
  it('makes a caller the implicit owner of their own personal account', async () => {
    const person = await seedAccount({ kind: 'personal' });

    const result = await resolveCallerAccountAccess(person, person);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.access.role).toBe('owner');
    expect(result.access.source).toBe('self');
    expect(result.access.accountPermissions).toContain('billing:read');
    expect(result.access.applicationPermissions).toContain('app:delete');
  });

  it('answers no-access for a stranger', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const stranger = await seedAccount({ kind: 'personal' });

    const result = await resolveCallerAccountAccess(stranger, org);

    expect(result).toEqual({ status: 'no-access', accountId: org });
  });

  it('carries both permission vocabularies for a direct member', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const member = await seedAccount({ kind: 'personal' });
    await seedMember(org, member, 'developer');

    const result = await resolveCallerAccountAccess(member, org);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.access.role).toBe('developer');
    expect(result.access.source).toBe('direct');
    // `developer` may rotate credentials but holds no billing right at all.
    expect(result.access.accountPermissions).toContain('credentials:rotate');
    expect(result.access.accountPermissions).not.toContain('billing:read');
    expect(result.access.applicationPermissions).toContain('usage:read');
    expect(result.access.applicationPermissions).not.toContain('billing:read');
  });
});

describe('empty-input guards', () => {
  it('refuses an empty caller/account pair instead of resolving it as self-ownership', async () => {
    // Load-bearing, not defensive noise: `resolveEffectiveAccess` treats
    // `userId === accountId` as implicit ownership of one's own personal
    // account, so a pair of empty strings reaching it resolves as OWNER with the
    // full permission set. The guard is what stops an unset id from becoming a
    // grant. A service token whose `appId` claim is `''` verifies today
    // (`middleware/serviceToken.ts` checks the type, not the length), so this
    // input is reachable.
    await expect(resolveCallerAccountAccess('', '')).resolves.toEqual({
      status: 'no-access',
      accountId: '',
    });

    // Control: the SAME shape with real ids does resolve as self-ownership, so
    // the refusal above is the guard and not a broken resolver.
    const person = await seedAccount({ kind: 'personal' });
    const control = await resolveCallerAccountAccess(person, person);
    expect(control.status).toBe('resolved');
    if (control.status !== 'resolved') return;
    expect(control.access.role).toBe('owner');
  });

  it('answers "unknown" for empty ids on the other three resolutions', async () => {
    await expect(resolveApplicationOwnerAccount('')).resolves.toEqual({
      status: 'unknown-application',
      applicationId: '',
    });
    await expect(resolveCredentialAttribution('')).resolves.toEqual({
      status: 'unknown-credential',
      clientId: '',
    });
    await expect(resolveAccountBillingProfile('')).resolves.toEqual({
      status: 'unknown-account',
      accountId: '',
    });
  });
});

describe('resolveCallerApplicationAccess — inheritance and revocation', () => {
  it('gives an organization member INHERITED access to an app owned by a descendant project', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const project = await seedAccount({
      kind: 'project',
      parentAccountId: org,
      rootAccountId: org,
      ancestors: [org],
    });
    const member = await seedAccount({ kind: 'personal' });
    await seedMember(org, member, 'admin', { inherit: true });
    const appId = await seedApplication(project);

    const result = await resolveCallerApplicationAccess(member, appId);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.access.application.ownerAccountId).toBe(project);
    expect(result.access.access.role).toBe('admin');
    expect(result.access.access.source).toBe('inherited');
    expect(result.access.access.applicationPermissions).toContain('app:update');
  });

  it('does NOT cascade an ancestor membership that opted out of inheritance', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const project = await seedAccount({
      kind: 'project',
      parentAccountId: org,
      rootAccountId: org,
      ancestors: [org],
    });
    const member = await seedAccount({ kind: 'personal' });
    await seedMember(org, member, 'admin', { inherit: false });
    const appId = await seedApplication(project);

    // Positive control: the same person DOES reach an app owned by the org
    // itself, so the refusal below is about inheritance and not about the
    // membership being broken.
    const orgAppId = await seedApplication(org);
    const onOrg = await resolveCallerApplicationAccess(member, orgAppId);
    expect(onOrg.status).toBe('resolved');

    const onProject = await resolveCallerApplicationAccess(member, appId);
    expect(onProject.status).toBe('no-access');
    if (onProject.status !== 'no-access') return;
    expect(onProject.ownerAccountId).toBe(project);
  });

  it('lets a NEARER row on the descendant project override the inherited role', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const project = await seedAccount({
      kind: 'project',
      parentAccountId: org,
      rootAccountId: org,
      ancestors: [org],
    });
    const member = await seedAccount({ kind: 'personal' });
    await seedMember(org, member, 'admin', { inherit: true });
    await seedMember(project, member, 'viewer');
    const appId = await seedApplication(project);

    const result = await resolveCallerApplicationAccess(member, appId);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.access.access.role).toBe('viewer');
    expect(result.access.access.source).toBe('direct');
    expect(result.access.access.applicationPermissions).not.toContain('app:update');
  });

  it('honours a per-member REVOKE on the descendant project', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const project = await seedAccount({
      kind: 'project',
      parentAccountId: org,
      rootAccountId: org,
      ancestors: [org],
    });
    const member = await seedAccount({ kind: 'personal' });
    await seedMember(project, member, 'admin', {
      permissionRevokes: ['apps:delete', 'billing:read'],
    });
    const appId = await seedApplication(project);

    const result = await resolveCallerApplicationAccess(member, appId);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    // Vacuity floor: an `admin` normally holds both of these, so their absence
    // is the revoke and not an empty permission set.
    expect(result.access.access.accountPermissions).toContain('apps:update');
    expect(result.access.access.accountPermissions).not.toContain('apps:delete');
    expect(result.access.access.accountPermissions).not.toContain('billing:read');
  });

  it('treats a REMOVED membership as no access', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const member = await seedAccount({ kind: 'personal' });
    await seedMember(org, member, 'admin', { status: 'removed' });
    const appId = await seedApplication(org);

    const result = await resolveCallerApplicationAccess(member, appId);
    expect(result.status).toBe('no-access');
  });

  it('hides a soft-deleted application by default and reveals it only on request', async () => {
    const person = await seedAccount({ kind: 'personal' });
    const appId = await seedApplication(person, { status: 'deleted' });

    const hidden = await resolveCallerApplicationAccess(person, appId);
    expect(hidden.status).toBe('unknown-application');

    const revealed = await resolveCallerApplicationAccess(person, appId, { includeDeleted: true });
    expect(revealed.status).toBe('resolved');
  });

  it('distinguishes an unknown application from a permission refusal', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const stranger = await seedAccount({ kind: 'personal' });
    const appId = await seedApplication(org);

    const missing = await resolveCallerApplicationAccess(
      stranger,
      '01a00000-0000-7000-8000-000000000001'
    );
    expect(missing.status).toBe('unknown-application');

    const refused = await resolveCallerApplicationAccess(stranger, appId);
    expect(refused.status).toBe('no-access');
  });
});

// ===========================================================================
// 4. owner account → billing profile
// ===========================================================================

describe('resolveAccountBillingProfile', () => {
  it('resolves a provisioned profile with its balances', async () => {
    const account = await seedAccount({ kind: 'organization' });
    await seedBillingProfile(account, {
      creditsFree: 250,
      creditsPaid: 4000,
      stripeCustomerId: `cus_attrib${uniqueSuffix()}`,
    });

    const result = await resolveAccountBillingProfile(account);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.profile.accountId).toBe(account);
    expect(result.profile.freeCredits).toBe(250);
    expect(result.profile.paidCredits).toBe(4000);
    expect(result.profile.stripeCustomerId).toMatch(/^cus_attrib/);
  });

  it('reports NOT-PROVISIONED for a real account that has never been billed', async () => {
    const org = await seedAccount({ kind: 'organization' });

    const result = await resolveAccountBillingProfile(org);

    expect(result).toEqual({ status: 'not-provisioned', accountId: org });
  });

  it('distinguishes an unknown account from an unprovisioned one', async () => {
    const missing = await resolveAccountBillingProfile('01a00000-0000-7000-8000-000000000002');
    expect(missing).toEqual({
      status: 'unknown-account',
      accountId: '01a00000-0000-7000-8000-000000000002',
    });
  });

  it('never provisions a profile as a side effect of resolving one', async () => {
    const org = await seedAccount({ kind: 'organization' });

    await resolveAccountBillingProfile(org);
    await resolveAccountBillingProfile(org);

    const rows = await getDb()
      .select({ userId: userCredits.userId })
      .from(userCredits)
      .where(eq(userCredits.userId, org));
    expect(rows).toHaveLength(0);
  });
});

describe('resolveApplicationBillingProfile', () => {
  it('charges an application to its OWNER account, not to whoever created it', async () => {
    const founder = await seedAccount({ kind: 'personal' });
    const org = await seedAccount({ kind: 'organization' });
    await seedMember(org, founder, 'owner');
    // The founder has a healthy personal balance; the organization has none.
    await seedBillingProfile(founder, { creditsPaid: 99_000 });
    await seedBillingProfile(org, { creditsPaid: 7 });
    const appId = await seedApplication(org);

    const result = await resolveApplicationBillingProfile(appId);

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.profile.accountId).toBe(org);
    expect(result.profile.paidCredits).toBe(7);
  });

  it('reports the organization gap: an org-owned app whose owner has no billing profile', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const appId = await seedApplication(org);

    const result = await resolveApplicationBillingProfile(appId);

    expect(result.status).toBe('not-provisioned');
    if (result.status !== 'not-provisioned') return;
    expect(result.application.ownerAccountId).toBe(org);
  });

  it('reports an unknown application', async () => {
    const result = await resolveApplicationBillingProfile('01a00000-0000-7000-8000-000000000003');
    expect(result.status).toBe('unknown-application');
  });
});

// ===========================================================================
// The cross-account balance boundary
// ===========================================================================

describe('callerMayReadApplicationBalance', () => {
  it('refuses a stranger, while a billing member of the SAME app is allowed', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const appId = await seedApplication(org);
    await seedBillingProfile(org, { creditsPaid: 12_345 });

    const stranger = await seedAccount({ kind: 'personal' });
    const treasurer = await seedAccount({ kind: 'personal' });
    await seedMember(org, treasurer, 'billing');

    // NEGATIVE: someone with no membership over the owning account.
    await expect(callerMayReadApplicationBalance(stranger, appId)).resolves.toBe(false);

    // POSITIVE CONTROL, in the same currency: the identical call, same
    // application, same balance, succeeds for a member — so the `false` above
    // cannot be a resolver that simply answers `false` for everything.
    await expect(callerMayReadApplicationBalance(treasurer, appId)).resolves.toBe(true);

    // And the balance the member is allowed to reach is real and non-zero, so
    // "there was nothing to leak" is not an alternative explanation.
    const profile = await resolveApplicationBillingProfile(appId);
    expect(profile.status).toBe('resolved');
    if (profile.status !== 'resolved') return;
    expect(profile.profile.paidCredits).toBe(12_345);
  });

  it('refuses a member who has account access but not billing:read', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const appId = await seedApplication(org);
    await seedBillingProfile(org, { creditsPaid: 500 });

    const developer = await seedAccount({ kind: 'personal' });
    await seedMember(org, developer, 'developer');

    // The discriminator: this caller DOES have access to the application — the
    // resolver resolves for them — and is still refused the balance. A gate that
    // keyed on membership rather than on `billing:read` would pass them.
    const access = await resolveCallerApplicationAccess(developer, appId);
    expect(access.status).toBe('resolved');

    await expect(callerMayReadApplicationBalance(developer, appId)).resolves.toBe(false);
  });

  it('refuses once billing:read is revoked from a member who otherwise holds it', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const appId = await seedApplication(org);
    const treasurer = await seedAccount({ kind: 'personal' });
    const memberId = await seedMember(org, treasurer, 'billing');

    await expect(callerMayReadApplicationBalance(treasurer, appId)).resolves.toBe(true);

    await getDb()
      .update(accountMembers)
      .set({ permissionRevokes: ['billing:read'] })
      .where(eq(accountMembers.id, memberId));

    await expect(callerMayReadApplicationBalance(treasurer, appId)).resolves.toBe(false);
  });

  it('refuses an inherited member of a sibling project, and allows the parent org member', async () => {
    const orgA = await seedAccount({ kind: 'organization' });
    const orgB = await seedAccount({ kind: 'organization' });
    const projectA = await seedAccount({
      kind: 'project',
      parentAccountId: orgA,
      rootAccountId: orgA,
      ancestors: [orgA],
    });
    const appId = await seedApplication(projectA);
    await seedBillingProfile(projectA, { creditsPaid: 900 });

    const outsider = await seedAccount({ kind: 'personal' });
    await seedMember(orgB, outsider, 'owner');

    const insider = await seedAccount({ kind: 'personal' });
    await seedMember(orgA, insider, 'billing', { inherit: true });

    // An owner of a DIFFERENT organization reaches nothing here.
    await expect(callerMayReadApplicationBalance(outsider, appId)).resolves.toBe(false);
    // Same call, same app: a billing member of the owning tree does.
    await expect(callerMayReadApplicationBalance(insider, appId)).resolves.toBe(true);
  });
});
