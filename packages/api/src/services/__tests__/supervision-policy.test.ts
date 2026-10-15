import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  users,
  blocks,
  supervisionContacts,
  supervisionProfiles,
  supervisionInvitations,
} from '../../db/schema';
import type { LiveAgencyServicePrincipal } from '../agencyServicePrincipal.service';
import {
  decideMessages,
  decideProfiles,
  decideContent,
  publicationPolicies,
  createSupervisedAssetPolicy,
} from '../supervisionPolicy.service';
import {
  inviteGuardian,
  acceptInvitation,
  reviewSupervision,
  changeContact,
  supervisionPeople,
  cancelInvitation,
  getSupervisionState,
} from '../supervision.service';

beforeAll(connectPostgres);
afterAll(closePostgres);
async function person(staff = false) {
  const [row] = await getDb()
    .insert(users)
    .values({
      kind: 'personal',
      isStaff: staff,
      username: `safety${randomUUID().slice(0, 8)}`,
      privacyProfileVisibility: true,
    })
    .returning({ id: users.id });
  if (!row) throw new Error('Missing safety fixture');
  return row.id;
}
const consumer: LiveAgencyServicePrincipal = {
  applicationId: 'reviewed-test-app',
  credentialId: 'live-test-credential',
  ownerAccountId: 'owner',
  scopes: ['safety:decide'],
  capabilities: ['safety:profile:v1', 'safety:messaging:v1', 'safety:content:v1'],
};
async function enrolled() {
  const child = await person(),
    guardian = await person(),
    contact = await person();
  const invitation = await inviteGuardian(child, guardian);
  await acceptInvitation(invitation.id, guardian);
  await changeContact(child, contact, guardian, true);
  return { child, guardian, contact };
}
describe('live supervised-personal policy', () => {
  it.each(['inactive', 'restricted', 'deleted'] as const)(
    'revokes contacts immediately for %s guardian',
    async (state) => {
      const { child, guardian, contact } = await enrolled();
      expect((await decideMessages([child, contact], child, consumer)).allowed).toBe(true);
      if (state === 'deleted') await getDb().delete(users).where(eq(users.id, guardian));
      else
        await getDb()
          .update(users)
          .set(
            state === 'restricted'
              ? { reputationTier: 'restricted' }
              : { accountStatus: 'archived' },
          )
          .where(eq(users.id, guardian));
      expect(await decideMessages([child, contact], child, consumer)).toMatchObject({
        allowed: false,
        reason: 'contact_not_approved',
      });
      expect((await decideProfiles([child], contact, consumer)).items[0].decision.allowed).toBe(
        false,
      );
    },
  );
  it('preserves an explicitly hidden profile even for approved contacts while permitting owner access', async () => {
    const { child, contact } = await enrolled();
    expect((await decideProfiles([child], contact, consumer)).items[0].decision.allowed).toBe(true);
    await getDb().update(users).set({ privacyProfileVisibility: false }).where(eq(users.id, child));
    expect((await decideProfiles([child], contact, consumer)).items[0].decision).toMatchObject({
      allowed: false,
      reason: 'private',
    });
    expect((await decideProfiles([child], child, consumer)).items[0].decision).toMatchObject({
      allowed: true,
      reason: 'owner',
    });
  });
  it('does not replace ordinary adult group blocking semantics', async () => {
    const a = await person(),
      b = await person();
    await getDb().insert(blocks).values({ userId: a, blockedId: b });
    expect(await decideMessages([a, b], a, null)).toMatchObject({ allowed: true });
    expect((await decideProfiles([a], b, null)).items[0].decision).toMatchObject({
      allowed: false,
      reason: 'blocked',
    });
  });
  it('checks every supervised pair in a full 256-participant group', async () => {
    const { child, guardian, contact } = await enrolled();
    const strangers = await getDb()
      .insert(users)
      .values(Array.from({ length: 253 }, () => ({ kind: 'personal' as const })))
      .returning({ id: users.id });
    const ids = [child, guardian, contact, ...strangers.map((x) => x.id)];
    expect(await decideMessages(ids, guardian, consumer)).toMatchObject({
      allowed: false,
      reason: 'contact_not_approved',
    });
    await getDb()
      .insert(supervisionContacts)
      .values(
        strangers.map(({ id }) => ({
          childAccountId: child,
          contactAccountId: id,
          approvedByAccountId: guardian,
        })),
      );
    expect((await decideMessages(ids, guardian, consumer)).allowed).toBe(true);
    await getDb().insert(blocks).values({ userId: strangers[252].id, blockedId: child });
    expect(await decideMessages(ids, guardian, consumer)).toMatchObject({
      allowed: false,
      reason: 'blocked',
    });
  });
  it('requires the reviewed action capability and rejects unrated and mature content', async () => {
    const { child, contact } = await enrolled();
    expect(
      await decideMessages([child, contact], child, { ...consumer, capabilities: [] }),
    ).toMatchObject({ allowed: false, reason: 'unsupported_consumer' });
    const result = await decideContent(
      ['general', 'mature', 'unrated'].map((classification) => ({
        resourceId: classification,
        classification: classification as 'general' | 'mature' | 'unrated',
      })),
      child,
      consumer,
    );
    expect(result.items.map((x) => x.decision.allowed)).toEqual([true, false, false]);
    expect((await decideProfiles([child], null, consumer)).items[0].decision.allowed).toBe(false);
  });
  it('never reactivates old contact approvals after ending and enrolling with a different guardian', async () => {
    const { child, contact } = await enrolled();
    const staff = await person(true),
      nextGuardian = await person();
    await reviewSupervision(staff, {
      childAccountId: child,
      action: 'end',
      evidenceReference: 'reviewed-transition',
      reauth: { password: 'checked-at-route' },
    });
    const invitation = await inviteGuardian(child, nextGuardian);
    await acceptInvitation(invitation.id, nextGuardian);
    expect(await decideMessages([child, contact], child, consumer)).toMatchObject({
      allowed: false,
      reason: 'contact_not_approved',
    });
    const rows = await getDb()
      .select()
      .from(supervisionContacts)
      .where(eq(supervisionContacts.childAccountId, child));
    expect(rows).toEqual([]);
    const [profile] = await getDb()
      .select()
      .from(supervisionProfiles)
      .where(eq(supervisionProfiles.childAccountId, child));
    expect(profile.guardianAccountId).toBe(nextGuardian);
  });
  it('applies private contact audiences to historical public posts without allowing ordinary audience grants to bypass blocks', async () => {
    const { child, guardian, contact } = await enrolled();
    const item = {
      resourceId: 'post',
      classification: 'general' as const,
      authorAccountId: child,
      audience: 'public' as const,
      applicationAudienceAllowed: true,
      applicationResourceGrant: true,
    };
    expect((await decideContent([item], null, consumer)).items[0].decision.allowed).toBe(false);
    expect(
      (
        await decideContent(
          [{ ...item, audience: 'private', applicationAudienceAllowed: false }],
          contact,
          consumer,
        )
      ).items[0].decision.allowed,
    ).toBe(true);
    await changeContact(child, contact, guardian, false);
    expect((await decideContent([item], contact, consumer)).items[0].decision.allowed).toBe(false);
    await getDb().insert(blocks).values({ userId: guardian, blockedId: child });
    expect((await decideContent([item], guardian, consumer)).items[0].decision).toMatchObject({
      allowed: false,
      reason: 'blocked',
    });
  });
  it('allows explicit own management of pending content but not nested other-author unrated reads', async () => {
    const { child, contact } = await enrolled();
    const own = {
      resourceId: 'own',
      classification: 'unrated' as const,
      authorAccountId: child,
      audience: 'private' as const,
      applicationAudienceAllowed: true,
    };
    const result = await decideContent(
      [
        { ...own, operation: 'manage_own' },
        { ...own, resourceId: 'feed', operation: 'read' },
        { ...own, resourceId: 'nested', authorAccountId: contact, operation: 'manage_own' },
      ],
      child,
      consumer,
    );
    expect(result.items.map((item) => item.decision.allowed)).toEqual([true, false, false]);
  });
  it('preserves explicit adult collaborator grants while ordinary public local audiences do not override private profiles', async () => {
    const author = await person(),
      viewer = await person();
    await getDb().update(users).set({ privacyIsPrivateAccount: true }).where(eq(users.id, author));
    const item = {
      resourceId: 'post',
      classification: 'general' as const,
      authorAccountId: author,
      audience: 'private' as const,
      applicationAudienceAllowed: true,
    };
    expect((await decideContent([item], viewer, consumer)).items[0].decision.allowed).toBe(false);
    expect(
      (await decideContent([{ ...item, applicationResourceGrant: true }], viewer, consumer))
        .items[0].decision.allowed,
    ).toBe(true);
    await getDb().insert(blocks).values({ userId: author, blockedId: viewer });
    expect(
      (await decideContent([{ ...item, applicationResourceGrant: true }], viewer, consumer))
        .items[0].decision.allowed,
    ).toBe(false);
  });
  it('rechecks publication constraints after enrollment and live account unavailability', async () => {
    const child = await person(),
      guardian = await person();
    expect(
      (await publicationPolicies([child], consumer)).items[0].policy.requiredAudience,
    ).toBeNull();
    await acceptInvitation((await inviteGuardian(child, guardian)).id, guardian);
    expect((await publicationPolicies([child], consumer)).items[0].policy).toMatchObject({
      publicationAllowed: true,
      requiredAudience: 'private',
      collaborationAllowed: false,
      federationAllowed: false,
    });
    await getDb().update(users).set({ accountStatus: 'archived' }).where(eq(users.id, child));
    expect((await publicationPolicies([child], consumer)).items[0].policy.publicationAllowed).toBe(
      false,
    );
  });

  it('does not let expired invitations from other children permanently exhaust a guardian queue', async () => {
    const guardian = await person(),
      child = await person();
    const previous = await getDb()
      .insert(users)
      .values(Array.from({ length: 100 }, () => ({ kind: 'personal' as const })))
      .returning({ id: users.id });
    await getDb()
      .insert(supervisionInvitations)
      .values(
        previous.map(({ id }) => ({
          childAccountId: id,
          guardianAccountId: guardian,
          consentVersion: '1',
          expiresAt: new Date(Date.now() - 1000),
        })),
      );
    expect(await inviteGuardian(child, guardian)).toMatchObject({
      childAccountId: child,
      guardianAccountId: guardian,
      status: 'pending',
    });
  });
});

it('loads one request-local graph for a hundred assets and rechecks revoked contacts on the next request', async()=>{
 const {child,guardian,contact}=await enrolled();
 const select=jest.spyOn(getDb(),'select');
 const policy=await createSupervisedAssetPolicy(Array.from({length:100},()=>child),contact);
 const graphQueries=select.mock.calls.length;
 expect(graphQueries).toBeLessThanOrEqual(5);
 expect(graphQueries).toBeGreaterThan(0);
 for(let i=0;i<100;i++)expect(policy(child,contact)?.allowed).toBe(true);
 expect(select).toHaveBeenCalledTimes(graphQueries);
 expect(policy(child,guardian)?.allowed).toBe(false);
 select.mockRestore();
 await changeContact(child,contact,guardian,false);
 const next=await createSupervisedAssetPolicy([child],contact);
 expect(next(child,contact)?.allowed).toBe(false);
});
it('returns only minimal eligible identities and never leaks unrelated private or blocked people',async()=>{
 const {child,guardian,contact}=await enrolled();const stranger=await person();
 await getDb().update(users).set({privacyIsPrivateAccount:true,nameDisplay:'Private guardian',bio:'Not for the selector'}).where(eq(users.id,guardian));
 await getDb().update(users).set({privacyIsPrivateAccount:true}).where(eq(users.id,stranger));
 const people=await supervisionPeople(child,{accountIds:[guardian,contact,stranger]});
 expect(people.items.map(p=>p.accountId).sort()).toEqual([guardian,contact].sort());
 expect(Object.keys(people.items[0]).sort()).toEqual(['accountId','displayName','username']);
 await getDb().insert(blocks).values({userId:contact,blockedId:child});
 expect((await supervisionPeople(child,{accountIds:[contact]})).items).toEqual([]);
 const [row]=await getDb().select({username:users.username}).from(users).where(eq(users.id,guardian));
 expect((await supervisionPeople(child,{query:row.username??'missing'})).items.map(p=>p.accountId)).toEqual([guardian]);
 expect((await supervisionPeople(child,{query:(row.username??'missing').slice(0,-1)})).items.map(p=>p.accountId)).not.toContain(guardian);
 await getDb().update(users).set({privacyProfileVisibility:false}).where(eq(users.id,guardian));
 expect((await supervisionPeople(child,{query:row.username??'missing'})).items).toEqual([]);
});

it('makes an invited account private immediately without claiming active supervision and keeps privacy after cancellation',async()=>{
 const child=await person(),guardian=await person();
 await getDb().update(users).set({privacyIsPrivateAccount:false}).where(eq(users.id,child));
 const invitation=await inviteGuardian(child,guardian);
 const privacy=async()=>{const [row]=await getDb().select({private:users.privacyIsPrivateAccount}).from(users).where(eq(users.id,child));return row.private;};
 expect(await privacy()).toBe(true);
 expect((await getSupervisionState(child)).self).toBeNull();
 expect((await getSupervisionState(guardian)).children).toEqual([]);
 await cancelInvitation(invitation.id,child);
 expect(await privacy()).toBe(true);
});
