import { publicColumns } from '@oxy.so/db/assert';
import { PROTECTED_COLUMNS_BY_TABLE } from '../db/schema/protectedColumns';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { accountInvitations } from '../db/schema/accountInvitations';
import { accountMembers } from '../db/schema/accountMembers';
import { users } from '../db/schema/users';
import { accountService, joinCommunityAsOperator } from './account.service';
import { invalidateAccountGraphCaches } from './followCommand.service';
import { sendAccountInvitation } from './accountEmail.mail';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/error';
import { resolveEffectivePermissions, type AccountRole } from '../utils/accountRoles';

type Invitation = Omit<typeof accountInvitations.$inferSelect, 'tokenHash'>;
const columns = () => publicColumns(accountInvitations, PROTECTED_COLUMNS_BY_TABLE);
type Role = Exclude<AccountRole, 'owner'>;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const credentials = () => {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hash(token), expiresAt: new Date(Date.now() + 7 * 86400000) };
};
const pending = (row: Invitation) =>
  !row.cancelledAt && !row.acceptedAt && row.expiresAt > new Date();
export function invitationDto(row: Invitation) {
  return {
    id: row.id,
    accountId: row.accountId,
    email: row.email,
    role: row.role,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    status: row.acceptedAt
      ? 'accepted'
      : row.cancelledAt
        ? 'cancelled'
        : row.expiresAt <= new Date()
          ? 'expired'
          : 'pending',
  };
}

/** Rechecked at creation, resend AND consumption: a departed inviter cannot grant access. */
async function authorize(
  accountId: string,
  actorId: string,
  permission: 'members:invite' | 'members:read' | 'members:remove',
  role?: Role,
  db: DatabaseOrTransaction = getDb(),
) {
  const access = await accountService.resolveEffectiveAccess(actorId, accountId, undefined, db);
  if (
    !access?.permissions.includes(permission) ||
    (role && resolveEffectivePermissions(role, [], []).some((p) => !access.permissions.includes(p)))
  ) {
    throw new ForbiddenError('You cannot grant this role or manage these invitations');
  }
}

export const accountInvitationService = {
  async create(
    accountId: string,
    actorId: string,
    input: { email: string; role: Role; inherit?: boolean },
  ) {
    await authorize(accountId, actorId, 'members:invite', input.role);
    const secret = credentials();
    const [row] = await getDb()
      .insert(accountInvitations)
      .values({
        accountId,
        invitedByUserId: actorId,
        email: input.email.trim().toLowerCase(),
        role: input.role,
        inherit: input.inherit ?? true,
        tokenHash: secret.tokenHash,
        expiresAt: secret.expiresAt,
      })
      .returning(columns());
    // Keep an unsent row manageable; failures are visible and resend rotates the secret.
    await sendAccountInvitation(row.email, secret.token, row.role);
    return invitationDto(row);
  },
  async list(accountId: string, actorId: string) {
    await authorize(accountId, actorId, 'members:read');
    return (
      await getDb()
        .select(columns())
        .from(accountInvitations)
        .where(
          and(
            eq(accountInvitations.accountId, accountId),
            isNull(accountInvitations.acceptedAt),
            isNull(accountInvitations.cancelledAt),
          ),
        )
    ).map(invitationDto);
  },
  async resend(accountId: string, actorId: string, id: string) {
    const row = await getDb().transaction(async (tx) => {
      const [existing] = await tx
        .select(columns())
        .from(accountInvitations)
        .where(and(eq(accountInvitations.id, id), eq(accountInvitations.accountId, accountId)))
        .for('update');
      if (!existing || existing.acceptedAt || existing.cancelledAt)
        throw new NotFoundError('Invitation no longer available');
      await authorize(accountId, actorId, 'members:invite', existing.role, tx);
      const secret = credentials();
      const [updated] = await tx
        .update(accountInvitations)
        .set({ tokenHash: secret.tokenHash, expiresAt: secret.expiresAt, invitedByUserId: actorId })
        .where(eq(accountInvitations.id, id))
        .returning(columns());
      return { updated, token: secret.token };
    });
    await sendAccountInvitation(row.updated.email, row.token, row.updated.role);
    return invitationDto(row.updated);
  },
  async cancel(accountId: string, actorId: string, id: string) {
    await authorize(accountId, actorId, 'members:remove');
    const [row] = await getDb()
      .update(accountInvitations)
      .set({ cancelledAt: new Date() })
      .where(
        and(
          eq(accountInvitations.id, id),
          eq(accountInvitations.accountId, accountId),
          isNull(accountInvitations.acceptedAt),
        ),
      )
      .returning(columns());
    if (!row) throw new NotFoundError('Invitation no longer available');
    return { success: true };
  },
  async preview(token: string) {
    const [row] = await getDb()
      .select(columns())
      .from(accountInvitations)
      .where(eq(accountInvitations.tokenHash, hash(token)));
    if (!row || !pending(row))
      throw new NotFoundError('Invitation expired, cancelled or already used');
    const [account] = await getDb()
      .select({ id: users.id, username: users.username, displayName: users.nameDisplay })
      .from(users)
      .where(and(eq(users.id, row.accountId), ne(users.accountStatus, 'archived')));
    if (!account) throw new NotFoundError('Account unavailable');
    return { invitation: invitationDto(row), account };
  },
  async accept(token: string, userId: string) {
    const { accepted, joined } = await getDb().transaction(async (tx) => {
      const [row] = await tx
        .select(columns())
        .from(accountInvitations)
        .where(eq(accountInvitations.tokenHash, hash(token)))
        .for('update');
      if (!row || !pending(row))
        throw new BadRequestError('Invitation expired, cancelled or already used');
      // Serialize against role edits/removal, including memberships on ancestors.
      // Existing membership mutations update these same rows and therefore wait.
      await tx
        .select({ id: accountMembers.id })
        .from(accountMembers)
        .where(eq(accountMembers.memberUserId, row.invitedByUserId))
        .for('share');
      await tx.select({ id: users.id }).from(users).where(eq(users.id, row.accountId)).for('share');
      const [inviter] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, row.invitedByUserId), ne(users.accountStatus, 'archived')))
        .for('share');
      if (!inviter) throw new ForbiddenError('Inviter no longer available');
      await authorize(row.accountId, row.invitedByUserId, 'members:invite', row.role, tx);
      const [person] = await tx
        .select({ kind: users.kind })
        .from(users)
        .where(and(eq(users.id, userId), ne(users.accountStatus, 'archived')))
        .for('share');
      if (person?.kind !== 'personal')
        throw new BadRequestError('Choose a personal account to accept');
      const [account] = await tx
        .select({ id: users.id, kind: users.kind })
        .from(users)
        .where(and(eq(users.id, row.accountId), ne(users.accountStatus, 'archived')))
        .for('share');
      if (!account) throw new NotFoundError('Account unavailable');
      const [member] = await tx
        .insert(accountMembers)
        .values({
          accountId: row.accountId,
          memberUserId: userId,
          role: row.role,
          inherit: row.inherit,
          status: 'active',
          joinedAt: new Date(),
          invitedByUserId: row.invitedByUserId,
        })
        .onConflictDoUpdate({
          target: [accountMembers.accountId, accountMembers.memberUserId],
          set: {
            role: row.role,
            inherit: row.inherit,
            status: 'active',
            joinedAt: new Date(),
            invitedByUserId: row.invitedByUserId,
            permissionGrants: [],
            permissionRevokes: [],
          },
          setWhere: ne(accountMembers.status, 'active'),
        })
        .returning();
      if (!member) throw new BadRequestError('This account already has access');
      const [consumed] = await tx
        .update(accountInvitations)
        .set({ acceptedAt: new Date(), acceptedByUserId: userId })
        .where(and(eq(accountInvitations.id, row.id), gt(accountInvitations.expiresAt, new Date())))
        .returning(columns());
      if (!consumed) throw new BadRequestError('Invitation expired');
      // A community's new moderator is one of its members too.
      const joined = await joinCommunityAsOperator(tx, account, userId);
      return { accepted: { accountId: row.accountId, success: true }, joined };
    });
    if (joined) await invalidateAccountGraphCaches(userId, [accepted.accountId]);
    return accepted;
  },
};
