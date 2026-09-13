/**
 * family.service tests — Oxy Family membership, against a REAL Postgres.
 *
 * Same style as `account.service.test.ts`: no mock, one shared database, every
 * test mints its own personal accounts and families so nothing depends on
 * another test's rows.
 */

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { familyMembers } from '../../db/schema/families';
import { users } from '../../db/schema/users';
import { familyService } from '../family.service';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

let seedCounter = 0;
function uniqueUsername(prefix: string): string {
  seedCounter += 1;
  return `${prefix}${seedCounter}z${Date.now().toString(36)}`;
}

async function personalUser(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ color: 'teal', kind: 'personal', username: uniqueUsername('fam') })
    .returning({ id: users.id });
  return row.id;
}

async function organizationAccount(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ color: 'teal', kind: 'organization', username: uniqueUsername('org') })
    .returning({ id: users.id });
  return row.id;
}

async function membershipRow(id: string) {
  const [row] = await getDb().select().from(familyMembers).where(eq(familyMembers.id, id));
  return row;
}

describe('createFamily', () => {
  it('makes the creator an active organizer', async () => {
    const organizerId = await personalUser();
    const { family, membership } = await familyService.createFamily(organizerId, 'The Smiths');

    expect(family.name).toBe('The Smiths');
    expect(membership.familyId).toBe(family.id);
    expect(membership.memberUserId).toBe(organizerId);
    expect(membership.role).toBe('organizer');
    expect(membership.status).toBe('active');
    expect(membership.joinedAt).not.toBeNull();
  });

  it('creates a nameless family when no name is given', async () => {
    const { family } = await familyService.createFamily(await personalUser());
    // The raw row, not the route's serialized DTO — a nullable column reads
    // back `null`. The route layer maps `?? undefined` for the wire.
    expect(family.name).toBeNull();
  });

  it('refuses a second family for someone already active in one', async () => {
    const organizerId = await personalUser();
    await familyService.createFamily(organizerId);

    await expect(familyService.createFamily(organizerId)).rejects.toThrow(
      /already belong to a family/i
    );
  });
});

describe('inviteMember', () => {
  it('creates a PENDING invite, never a silent add', async () => {
    const organizerId = await personalUser();
    const inviteeId = await personalUser();
    const { family } = await familyService.createFamily(organizerId);

    const member = await familyService.inviteMember(family.id, organizerId, inviteeId);

    expect(member.status).toBe('invited');
    expect(member.role).toBe('member');
    expect(member.joinedAt).toBeNull();
    expect(member.invitedByUserId).toBe(organizerId);
  });

  it('refuses when the caller is not the organizer', async () => {
    const organizerId = await personalUser();
    const memberId = await personalUser();
    const { family } = await familyService.createFamily(organizerId);
    const invited = await familyService.inviteMember(family.id, organizerId, memberId);
    await familyService.acceptInvite(family.id, invited.id, memberId);

    await expect(
      familyService.inviteMember(family.id, memberId, await personalUser())
    ).rejects.toThrow(/only the family organizer/i);
  });

  it('refuses when the caller has no membership on the family at all', async () => {
    const { family } = await familyService.createFamily(await personalUser());

    await expect(
      familyService.inviteMember(family.id, await personalUser(), await personalUser())
    ).rejects.toThrow(/not a member of this family/i);
  });

  it('refuses inviting a non-personal account', async () => {
    const organizerId = await personalUser();
    const { family } = await familyService.createFamily(organizerId);

    await expect(
      familyService.inviteMember(family.id, organizerId, await organizationAccount())
    ).rejects.toThrow(/only personal accounts/i);
  });

  it('refuses inviting oneself', async () => {
    const organizerId = await personalUser();
    const { family } = await familyService.createFamily(organizerId);

    await expect(familyService.inviteMember(family.id, organizerId, organizerId)).rejects.toThrow(
      /cannot invite yourself/i
    );
  });

  it('refuses inviting someone already active in the family', async () => {
    const organizerId = await personalUser();
    const memberId = await personalUser();
    const { family } = await familyService.createFamily(organizerId);
    const invited = await familyService.inviteMember(family.id, organizerId, memberId);
    await familyService.acceptInvite(family.id, invited.id, memberId);

    await expect(familyService.inviteMember(family.id, organizerId, memberId)).rejects.toThrow(
      /already a member/i
    );
  });

  it('refuses a duplicate invite while one is already pending', async () => {
    const organizerId = await personalUser();
    const memberId = await personalUser();
    const { family } = await familyService.createFamily(organizerId);
    await familyService.inviteMember(family.id, organizerId, memberId);

    await expect(familyService.inviteMember(family.id, organizerId, memberId)).rejects.toThrow(
      /already been invited/i
    );
  });

  it('re-invites (reactivates) a previously removed member as a fresh PENDING row', async () => {
    const organizerId = await personalUser();
    const memberId = await personalUser();
    const { family } = await familyService.createFamily(organizerId);
    const firstInvite = await familyService.inviteMember(family.id, organizerId, memberId);
    await familyService.declineInvite(family.id, firstInvite.id, memberId);

    const reinvited = await familyService.inviteMember(family.id, organizerId, memberId);

    expect(reinvited.id).toBe(firstInvite.id);
    expect(reinvited.status).toBe('invited');
    expect(reinvited.joinedAt).toBeNull();
  });
});

describe('acceptInvite', () => {
  it('activates the membership and stamps joinedAt', async () => {
    const organizerId = await personalUser();
    const memberId = await personalUser();
    const { family } = await familyService.createFamily(organizerId);
    const invited = await familyService.inviteMember(family.id, organizerId, memberId);

    const accepted = await familyService.acceptInvite(family.id, invited.id, memberId);

    expect(accepted.status).toBe('active');
    expect(accepted.joinedAt).not.toBeNull();
  });

  it('refuses when the caller is not the invitee', async () => {
    const organizerId = await personalUser();
    const memberId = await personalUser();
    const { family } = await familyService.createFamily(organizerId);
    const invited = await familyService.inviteMember(family.id, organizerId, memberId);

    await expect(
      familyService.acceptInvite(family.id, invited.id, await personalUser())
    ).rejects.toThrow(/not your invitation/i);
  });

  it('refuses accepting a row that is no longer pending', async () => {
    const organizerId = await personalUser();
    const memberId = await personalUser();
    const { family } = await familyService.createFamily(organizerId);
    const invited = await familyService.inviteMember(family.id, organizerId, memberId);
    await familyService.acceptInvite(family.id, invited.id, memberId);

    await expect(familyService.acceptInvite(family.id, invited.id, memberId)).rejects.toThrow(
      /no longer pending/i
    );
  });

  it('refuses accepting while already active in a different family', async () => {
    const memberId = await personalUser();
    await familyService.createFamily(memberId); // already active elsewhere

    const organizerId = await personalUser();
    const { family: secondFamily } = await familyService.createFamily(organizerId);
    const invited = await familyService.inviteMember(secondFamily.id, organizerId, memberId);

    await expect(
      familyService.acceptInvite(secondFamily.id, invited.id, memberId)
    ).rejects.toThrow(/already belong to a family/i);
  });
});

describe('declineInvite', () => {
  it('removes the pending row', async () => {
    const organizerId = await personalUser();
    const memberId = await personalUser();
    const { family } = await familyService.createFamily(organizerId);
    const invited = await familyService.inviteMember(family.id, organizerId, memberId);

    await familyService.declineInvite(family.id, invited.id, memberId);

    const row = await membershipRow(invited.id);
    expect(row.status).toBe('removed');
  });

  it('refuses when the caller is not the invitee', async () => {
    const organizerId = await personalUser();
    const memberId = await personalUser();
    const { family } = await familyService.createFamily(organizerId);
    const invited = await familyService.inviteMember(family.id, organizerId, memberId);

    await expect(
      familyService.declineInvite(family.id, invited.id, await personalUser())
    ).rejects.toThrow(/not your invitation/i);
  });
});

describe('getMyFamily', () => {
  it('returns null for someone in no family', async () => {
    expect(await familyService.getMyFamily(await personalUser())).toBeNull();
  });

  it('returns the family and its roster, invited rows included', async () => {
    const organizerId = await personalUser();
    const memberId = await personalUser();
    const pendingId = await personalUser();
    const { family } = await familyService.createFamily(organizerId, 'Roster Test');
    const invited = await familyService.inviteMember(family.id, organizerId, memberId);
    await familyService.acceptInvite(family.id, invited.id, memberId);
    await familyService.inviteMember(family.id, organizerId, pendingId);

    const roster = await familyService.getMyFamily(organizerId);

    expect(roster?.family.id).toBe(family.id);
    const statuses = roster?.members.map((m) => `${m.memberUserId}:${m.status}`);
    expect(statuses).toEqual(
      expect.arrayContaining([
        `${organizerId}:active`,
        `${memberId}:active`,
        `${pendingId}:invited`,
      ])
    );
  });

  it('excludes removed members from the roster', async () => {
    const organizerId = await personalUser();
    const memberId = await personalUser();
    const { family } = await familyService.createFamily(organizerId);
    const invited = await familyService.inviteMember(family.id, organizerId, memberId);
    await familyService.declineInvite(family.id, invited.id, memberId);

    const roster = await familyService.getMyFamily(organizerId);
    expect(roster?.members.some((m) => m.memberUserId === memberId)).toBe(false);
  });
});

describe('listPendingInvites', () => {
  it('lists every family that has invited this person and not yet been answered', async () => {
    const memberId = await personalUser();
    const organizerAId = await personalUser();
    const organizerBId = await personalUser();
    const { family: familyA } = await familyService.createFamily(organizerAId);
    const { family: familyB } = await familyService.createFamily(organizerBId);
    await familyService.inviteMember(familyA.id, organizerAId, memberId);
    await familyService.inviteMember(familyB.id, organizerBId, memberId);

    const invites = await familyService.listPendingInvites(memberId);

    expect(invites).toHaveLength(2);
    expect(invites.map((i) => i.family.id).sort()).toEqual([familyA.id, familyB.id].sort());
    expect(invites.every((i) => i.membership.status === 'invited')).toBe(true);
  });

  it('is empty once the invite is answered', async () => {
    const organizerId = await personalUser();
    const memberId = await personalUser();
    const { family } = await familyService.createFamily(organizerId);
    const invited = await familyService.inviteMember(family.id, organizerId, memberId);
    await familyService.acceptInvite(family.id, invited.id, memberId);

    expect(await familyService.listPendingInvites(memberId)).toHaveLength(0);
  });
});

describe('removeMember', () => {
  it('lets the organizer remove an active member', async () => {
    const organizerId = await personalUser();
    const memberId = await personalUser();
    const { family } = await familyService.createFamily(organizerId);
    const invited = await familyService.inviteMember(family.id, organizerId, memberId);
    await familyService.acceptInvite(family.id, invited.id, memberId);

    await familyService.removeMember(family.id, invited.id, organizerId);

    const row = await membershipRow(invited.id);
    expect(row.status).toBe('removed');
  });

  it('refuses when the caller is not the organizer', async () => {
    const organizerId = await personalUser();
    const memberAId = await personalUser();
    const memberBId = await personalUser();
    const { family } = await familyService.createFamily(organizerId);
    const invitedA = await familyService.inviteMember(family.id, organizerId, memberAId);
    await familyService.acceptInvite(family.id, invitedA.id, memberAId);
    const invitedB = await familyService.inviteMember(family.id, organizerId, memberBId);
    await familyService.acceptInvite(family.id, invitedB.id, memberBId);

    await expect(
      familyService.removeMember(family.id, invitedB.id, memberAId)
    ).rejects.toThrow(/only the family organizer/i);
  });

  it('refuses removing oneself — that is what leave is for', async () => {
    const organizerId = await personalUser();
    const memberId = await personalUser();
    const { family, membership: organizerMembership } = await familyService.createFamily(
      organizerId
    );
    const invited = await familyService.inviteMember(family.id, organizerId, memberId);
    await familyService.acceptInvite(family.id, invited.id, memberId);

    await expect(
      familyService.removeMember(family.id, organizerMembership.id, organizerId)
    ).rejects.toThrow(/use post .*\/leave/i);
  });
});

describe('leaveFamily', () => {
  it('lets a plain member leave', async () => {
    const organizerId = await personalUser();
    const memberId = await personalUser();
    const { family } = await familyService.createFamily(organizerId);
    const invited = await familyService.inviteMember(family.id, organizerId, memberId);
    await familyService.acceptInvite(family.id, invited.id, memberId);

    await familyService.leaveFamily(family.id, memberId);

    const row = await membershipRow(invited.id);
    expect(row.status).toBe('removed');
  });

  it('lets the sole organizer leave, dissolving the family', async () => {
    const organizerId = await personalUser();
    const { family, membership } = await familyService.createFamily(organizerId);

    await familyService.leaveFamily(family.id, organizerId);

    const row = await membershipRow(membership.id);
    expect(row.status).toBe('removed');
  });

  it('refuses the organizer leaving while other active members remain', async () => {
    const organizerId = await personalUser();
    const memberId = await personalUser();
    const { family } = await familyService.createFamily(organizerId);
    const invited = await familyService.inviteMember(family.id, organizerId, memberId);
    await familyService.acceptInvite(family.id, invited.id, memberId);

    await expect(familyService.leaveFamily(family.id, organizerId)).rejects.toThrow(
      /remove the other members/i
    );
  });

  it('refuses leaving a family the caller does not belong to', async () => {
    const { family } = await familyService.createFamily(await personalUser());

    await expect(familyService.leaveFamily(family.id, await personalUser())).rejects.toThrow(
      /not a member of this family/i
    );
  });

  it('lets someone leave and later join a different family', async () => {
    const organizerId = await personalUser();
    const memberId = await personalUser();
    const { family: firstFamily } = await familyService.createFamily(organizerId);
    const invited = await familyService.inviteMember(firstFamily.id, organizerId, memberId);
    await familyService.acceptInvite(firstFamily.id, invited.id, memberId);
    await familyService.leaveFamily(firstFamily.id, memberId);

    const { family: secondFamily, membership } = await familyService.createFamily(memberId);
    expect(secondFamily.id).not.toBe(firstFamily.id);
    expect(membership.status).toBe('active');
  });
});
