/**
 * Family Service — Oxy Family membership.
 *
 * See `db/schema/families.ts` for the design decision (dedicated tables,
 * not `users.kind` + `account_members`) and the "one family at a time" rule.
 *
 * ## Every action here resolves the OPERATOR, never the session subject
 *
 * A family membership names a HUMAN. If the caller is currently operating a
 * switched-into account (`POST /accounts/:id/switch`), the session subject is
 * that managed account, not a person — so every route calls
 * `resolveOperatorId(req)` (mirroring `routes/accounts.ts`) and passes the
 * result in here as `userId`. This service never reads `req` itself.
 *
 * ## The one-family-at-a-time invariant is enforced at TWO layers
 *
 * `family_members_member_user_id_active_key` (a partial unique index on
 * `member_user_id` WHERE `status = 'active'`) is the backstop — it cannot be
 * violated no matter what bug reaches this file. This service ALSO checks
 * before writing, so a caller gets a clear 409 naming the reason instead of a
 * raw unique-violation 500 from the database.
 */

import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { families, familyMembers } from '../db/schema/families';
import { users } from '../db/schema/users';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../utils/error';
import { logger } from '../utils/logger';

export type FamilyRow = typeof families.$inferSelect;
export type FamilyMemberRow = typeof familyMembers.$inferSelect;

/** The roster entry shape `listFamily` returns — a membership row is enough; the client resolves profiles by id. */
export interface FamilyRoster {
  family: FamilyRow;
  members: FamilyMemberRow[];
}

/** A pending invite, with just enough about the family to show it in an invite list. */
export interface PendingFamilyInvite {
  membership: FamilyMemberRow;
  family: FamilyRow;
}

/** The caller's current ACTIVE family membership row, or `null`. */
async function findActiveMembership(userId: string): Promise<FamilyMemberRow | null> {
  const [row] = await getDb()
    .select()
    .from(familyMembers)
    .where(and(eq(familyMembers.memberUserId, userId), eq(familyMembers.status, 'active')))
    .limit(1);
  return row ?? null;
}

/** Refuse if `userId` already holds an active family membership other than `exceptMembershipId`. */
async function assertNoOtherActiveFamily(
  userId: string,
  exceptMembershipId?: string
): Promise<void> {
  const existing = await findActiveMembership(userId);
  if (existing && existing.id !== exceptMembershipId) {
    throw new ConflictError(
      'You already belong to a family. Leave it before joining another.'
    );
  }
}

export class FamilyService {
  /**
   * Create a family. The creator becomes its `organizer`, active immediately —
   * there is no invite-accept step for the person creating the family, since
   * nobody added them but themselves.
   */
  async createFamily(
    organizerUserId: string,
    name?: string
  ): Promise<{ family: FamilyRow; membership: FamilyMemberRow }> {
    await assertNoOtherActiveFamily(organizerUserId);

    const db = getDb();
    const result = await db.transaction(async (tx) => {
      const [family] = await tx.insert(families).values({ name }).returning();
      const [membership] = await tx
        .insert(familyMembers)
        .values({
          familyId: family.id,
          memberUserId: organizerUserId,
          role: 'organizer',
          status: 'active',
          joinedAt: new Date(),
        })
        .returning();
      return { family, membership };
    });

    logger.info('Family created', { familyId: result.family.id, organizerUserId });
    return result;
  }

  /**
   * The caller's current family and its roster (every non-`removed` row,
   * `invited` ones included — an organizer needs to see who they have invited).
   * `null` when the caller belongs to no family.
   */
  async getMyFamily(userId: string): Promise<FamilyRoster | null> {
    const membership = await findActiveMembership(userId);
    if (!membership) {
      return null;
    }

    const db = getDb();
    const [family] = await db
      .select()
      .from(families)
      .where(eq(families.id, membership.familyId))
      .limit(1);
    if (!family) {
      // The membership's own FK guarantees this cannot happen; kept as a
      // narrow guard rather than a non-null assertion.
      throw new NotFoundError('Family not found');
    }

    const members = await db
      .select()
      .from(familyMembers)
      .where(
        and(eq(familyMembers.familyId, family.id), ne(familyMembers.status, 'removed'))
      )
      .orderBy(asc(familyMembers.createdAt));

    return { family, members };
  }

  /** Pending invites addressed to `userId` — every family that has invited them and not yet been answered. */
  async listPendingInvites(userId: string): Promise<PendingFamilyInvite[]> {
    const rows = await getDb()
      .select({ membership: familyMembers, family: families })
      .from(familyMembers)
      .innerJoin(families, eq(families.id, familyMembers.familyId))
      .where(and(eq(familyMembers.memberUserId, userId), eq(familyMembers.status, 'invited')))
      .orderBy(asc(familyMembers.createdAt));
    return rows;
  }

  /** The caller's own row on `familyId`, active, or a 404. */
  private async requireActiveMembership(
    familyId: string,
    userId: string
  ): Promise<FamilyMemberRow> {
    const [row] = await getDb()
      .select()
      .from(familyMembers)
      .where(
        and(
          eq(familyMembers.familyId, familyId),
          eq(familyMembers.memberUserId, userId),
          eq(familyMembers.status, 'active')
        )
      )
      .limit(1);
    if (!row) {
      throw new NotFoundError('You are not a member of this family');
    }
    return row;
  }

  /** A membership row by (familyId, membershipId), any non-removed status, or a 404. */
  private async requireMembershipRow(
    familyId: string,
    membershipId: string
  ): Promise<FamilyMemberRow> {
    const [row] = await getDb()
      .select()
      .from(familyMembers)
      .where(and(eq(familyMembers.id, membershipId), eq(familyMembers.familyId, familyId)))
      .limit(1);
    if (!row || row.status === 'removed') {
      throw new NotFoundError('Family membership not found');
    }
    return row;
  }

  /**
   * Invite a user to a family. `inviterUserId` must be the family's active
   * organizer. The invitee must be a `personal` account — inviting an
   * organization/bot/channel/project to a family is nonsensical, since Family
   * memberships are between people.
   *
   * ONE statement decides between inserting and reactivating a prior
   * `removed` row, mirroring `AccountService.addMember` — except the
   * reactivated status is `invited`, never `active`: a re-invitation is a
   * fresh invitation, not a silent re-add.
   */
  async inviteMember(
    familyId: string,
    inviterUserId: string,
    targetUserId: string
  ): Promise<FamilyMemberRow> {
    const organizer = await this.requireActiveMembership(familyId, inviterUserId);
    if (organizer.role !== 'organizer') {
      throw new ForbiddenError('Only the family organizer may invite members');
    }

    const [target] = await getDb()
      .select({ id: users.id, kind: users.kind })
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1);
    if (!target) {
      throw new NotFoundError('User not found');
    }
    if (target.kind !== 'personal') {
      throw new BadRequestError('Only personal accounts can be invited to a family');
    }
    if (target.id === inviterUserId) {
      throw new BadRequestError('You cannot invite yourself');
    }

    const [existing] = await getDb()
      .select({ status: familyMembers.status })
      .from(familyMembers)
      .where(
        and(eq(familyMembers.familyId, familyId), eq(familyMembers.memberUserId, target.id))
      )
      .limit(1);
    if (existing?.status === 'active') {
      throw new ConflictError('User is already a member of this family');
    }
    if (existing?.status === 'invited') {
      throw new ConflictError('User has already been invited to this family');
    }

    const [member] = await getDb()
      .insert(familyMembers)
      .values({
        familyId,
        memberUserId: target.id,
        role: 'member',
        status: 'invited',
        invitedByUserId: inviterUserId,
        joinedAt: null,
      })
      .onConflictDoUpdate({
        target: [familyMembers.familyId, familyMembers.memberUserId],
        set: {
          role: 'member',
          status: 'invited',
          invitedByUserId: inviterUserId,
          joinedAt: null,
        },
      })
      .returning();

    logger.info('Family member invited', { familyId, memberId: member.id, by: inviterUserId });
    return member;
  }

  /**
   * Accept a pending invite. Only the invitee may accept their own invite, and
   * only while it is still `invited`. Refuses when the caller already belongs
   * to another active family — see the header on the "one family at a time"
   * invariant.
   */
  async acceptInvite(
    familyId: string,
    membershipId: string,
    callerUserId: string
  ): Promise<FamilyMemberRow> {
    const membership = await this.requireMembershipRow(familyId, membershipId);
    if (membership.memberUserId !== callerUserId) {
      throw new ForbiddenError('This is not your invitation');
    }
    if (membership.status !== 'invited') {
      throw new BadRequestError('This invitation is no longer pending');
    }

    await assertNoOtherActiveFamily(callerUserId, membershipId);

    const [updated] = await getDb()
      .update(familyMembers)
      .set({ status: 'active', joinedAt: new Date() })
      .where(eq(familyMembers.id, membershipId))
      .returning();

    logger.info('Family invite accepted', { familyId, memberId: updated.id, userId: callerUserId });
    return updated;
  }

  /** Decline a pending invite. Only the invitee may decline their own invite. */
  async declineInvite(
    familyId: string,
    membershipId: string,
    callerUserId: string
  ): Promise<void> {
    const membership = await this.requireMembershipRow(familyId, membershipId);
    if (membership.memberUserId !== callerUserId) {
      throw new ForbiddenError('This is not your invitation');
    }
    if (membership.status !== 'invited') {
      throw new BadRequestError('This invitation is no longer pending');
    }

    await getDb()
      .update(familyMembers)
      .set({ status: 'removed' })
      .where(eq(familyMembers.id, membershipId));

    logger.info('Family invite declined', { familyId, memberId: membershipId, userId: callerUserId });
  }

  /**
   * Remove another member. Organizer only, and never on oneself — the
   * organizer leaves via {@link leaveFamily} like everyone else.
   */
  async removeMember(
    familyId: string,
    membershipId: string,
    callerUserId: string
  ): Promise<void> {
    const organizer = await this.requireActiveMembership(familyId, callerUserId);
    if (organizer.role !== 'organizer') {
      throw new ForbiddenError('Only the family organizer may remove members');
    }

    const target = await this.requireMembershipRow(familyId, membershipId);
    if (target.memberUserId === callerUserId) {
      throw new BadRequestError('Use POST /families/:id/leave to remove yourself');
    }
    if (target.role === 'organizer') {
      // Structurally unreachable — `family_members_family_id_organizer_key`
      // permits at most one active organizer, and the caller already holds
      // that seat — but stated rather than assumed.
      throw new ForbiddenError('Cannot remove the family organizer');
    }

    await getDb()
      .update(familyMembers)
      .set({ status: 'removed' })
      .where(eq(familyMembers.id, target.id));

    logger.info('Family member removed', { familyId, memberId: target.id, by: callerUserId });
  }

  /**
   * Leave a family. An organizer may leave only when they are the sole active
   * member — there is no organizer-transfer endpoint in this pass, so an
   * organizer with other active members must remove them first (or ask them
   * to leave) before they can leave themselves.
   */
  async leaveFamily(familyId: string, callerUserId: string): Promise<void> {
    const membership = await this.requireActiveMembership(familyId, callerUserId);

    if (membership.role === 'organizer') {
      const [{ count }] = await getDb()
        .select({ count: sql<number>`count(*)::int` })
        .from(familyMembers)
        .where(
          and(
            eq(familyMembers.familyId, familyId),
            eq(familyMembers.status, 'active'),
            ne(familyMembers.id, membership.id)
          )
        );
      if (count > 0) {
        throw new BadRequestError(
          'Remove the other members before leaving — there is no organizer transfer in this release'
        );
      }
    }

    await getDb()
      .update(familyMembers)
      .set({ status: 'removed' })
      .where(eq(familyMembers.id, membership.id));

    logger.info('Family member left', { familyId, memberId: membership.id, userId: callerUserId });
  }
}

export const familyService = new FamilyService();
export default familyService;
