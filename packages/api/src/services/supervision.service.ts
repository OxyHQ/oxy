import { invalidateSupervision } from './supervisionPolicy.service';
import {
  announceSessionRevocations,
  announceUserSessionsRevoked,
  deactivateSessionRows,
  type RevokedSession,
} from './sessionRevocation.service';
import { and, asc, desc, eq, gt, inArray, lt, lte, ne, or, sql } from 'drizzle-orm';
import {
  supervisionSchema,
  supervisionInvitationSchema,
  purchaseApprovalSchema,
  purchaseApprovalSummarySchema,
  purchaseEffectsSchema,
  reservePurchaseSchema,
  type PurchaseEffects,
  type ReservePurchase,
  type ConfirmPurchase,
  type CancelPurchase,
  type SafetyErrorCode,
  type SupervisionReviewInput,
  type SafetyPeopleInput,
} from '@oxy.so/contracts';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import {
  users,
  blocks,
  sessions,
  supervisionProfiles,
  supervisionInvitations,
  supervisionContacts,
  supervisionPurchaseApprovals,
  supervisionPurchaseLines,
  supervisionAudit,
} from '../db/schema';
import userCache from '../utils/userCache';
import { visibleOrganizationIdentityPredicate } from '../utils/profileQuery';

const supervisionProfilesFields = {
  childAccountId: supervisionProfiles.childAccountId,
  guardianAccountId: supervisionProfiles.guardianAccountId,
  status: supervisionProfiles.status,
  consentVersion: supervisionProfiles.consentVersion,
  sessionsValidAfter: supervisionProfiles.sessionsValidAfter,
  createdAt: supervisionProfiles.createdAt,
  updatedAt: supervisionProfiles.updatedAt,
};
const supervisionInvitationsFields = {
  id: supervisionInvitations.id,
  childAccountId: supervisionInvitations.childAccountId,
  guardianAccountId: supervisionInvitations.guardianAccountId,
  status: supervisionInvitations.status,
  consentVersion: supervisionInvitations.consentVersion,
  expiresAt: supervisionInvitations.expiresAt,
  acceptedAt: supervisionInvitations.acceptedAt,
  createdAt: supervisionInvitations.createdAt,
};
const supervisionPurchaseApprovalsFields = {
  id: supervisionPurchaseApprovals.id,
  childAccountId: supervisionPurchaseApprovals.childAccountId,
  applicationId: supervisionPurchaseApprovals.applicationId,
  operationId: supervisionPurchaseApprovals.operationId,
  resourceId: supervisionPurchaseApprovals.resourceId,
  cartFingerprint: supervisionPurchaseApprovals.cartFingerprint,
  summary: supervisionPurchaseApprovals.summary,
  shippingMinor: supervisionPurchaseApprovals.shippingMinor,
  taxMinor: supervisionPurchaseApprovals.taxMinor,
  discountMinor: supervisionPurchaseApprovals.discountMinor,
  roundingAdjustmentMinor: supervisionPurchaseApprovals.roundingAdjustmentMinor,
  evidenceSealed: supervisionPurchaseApprovals.evidenceSealed,
  merchantAccountIds: supervisionPurchaseApprovals.merchantAccountIds,
  paymentFingerprint: supervisionPurchaseApprovals.paymentFingerprint,
  amountMinor: supervisionPurchaseApprovals.amountMinor,
  currency: supervisionPurchaseApprovals.currency,
  expiresAt: supervisionPurchaseApprovals.expiresAt,
  status: supervisionPurchaseApprovals.status,
  reviewedByAccountId: supervisionPurchaseApprovals.reviewedByAccountId,
  reviewedAt: supervisionPurchaseApprovals.reviewedAt,
  reservedAt: supervisionPurchaseApprovals.reservedAt,
  receiptReference: supervisionPurchaseApprovals.receiptReference,
  createdAt: supervisionPurchaseApprovals.createdAt,
  updatedAt: supervisionPurchaseApprovals.updatedAt,
};
const supervisionContactsFields = {
  childAccountId: supervisionContacts.childAccountId,
  contactAccountId: supervisionContacts.contactAccountId,
  approvedByAccountId: supervisionContacts.approvedByAccountId,
  approvedAt: supervisionContacts.approvedAt,
};
export class SafetyError extends Error {
  constructor(
    readonly status: number,
    readonly code: SafetyErrorCode,
    message: string,
  ) {
    super(message);
  }
}
const forbidden = () => new SafetyError(403, 'forbidden', 'This safety change is not authorized');
const conflict = () =>
  new SafetyError(409, 'conflict', 'The safety request changed or is no longer eligible');
const missing = () => new SafetyError(404, 'not_found', 'Safety request not found');
const limit = () =>
  new SafetyError(422, 'limit_reached', 'The maximum number of safety entries has been reached');
async function lockPeople(tx: DatabaseOrTransaction, ids: string[]) {
  const rows = await tx
    .select({
      id: users.id,
      kind: users.kind,
      status: users.accountStatus,
      reputation: users.reputationTier,
    })
    .from(users)
    .where(inArray(users.id, [...new Set(ids)]))
    .orderBy(asc(users.id))
    // Serialize policy enrollment without blocking audit/approval foreign-key reads.
    .for('no key update');
  if (
    rows.length !== new Set(ids).size ||
    rows.some(
      (r) => r.kind !== 'personal' || r.status !== 'active' || r.reputation === 'restricted',
    )
  )
    throw forbidden();
}
async function assertGuardian(tx: DatabaseOrTransaction, childId: string, actorId: string) {
  const [profile] = await tx
    .select(supervisionProfilesFields)
    .from(supervisionProfiles)
    .where(eq(supervisionProfiles.childAccountId, childId))
    .for('update');
  if (!profile || profile.status !== 'active' || profile.guardianAccountId !== actorId)
    throw forbidden();
  const [guardian] = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, actorId),
        eq(users.kind, 'personal'),
        eq(users.accountStatus, 'active'),
        ne(users.reputationTier, 'restricted'),
      ),
    );
  if (!guardian) throw forbidden();
  return profile;
}
function profileDto(row: typeof supervisionProfiles.$inferSelect) {
  return supervisionSchema.parse({
    childAccountId: row.childAccountId,
    guardianAccountId: row.guardianAccountId,
    status: row.status === 'active' && !row.guardianAccountId ? 'orphaned' : row.status,
    policyVersion: '2',
    consentVersion: row.consentVersion,
    createdAt: row.createdAt.toISOString(),
  });
}
function invitationDto(row: typeof supervisionInvitations.$inferSelect) {
  return supervisionInvitationSchema.parse({
    id: row.id,
    childAccountId: row.childAccountId,
    guardianAccountId: row.guardianAccountId,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    consentVersion: row.consentVersion,
    createdAt: row.createdAt.toISOString(),
  });
}
async function audit(
  tx: DatabaseOrTransaction,
  childAccountId: string,
  actorAccountId: string | null,
  action: string,
  details: {
    relatedAccountId?: string;
    resourceId?: string;
    evidenceReference?: string;
    applicationId?: string;
  } = {},
) {
  await tx.insert(supervisionAudit).values({ childAccountId, actorAccountId, action, ...details });
}
export async function getSupervisionState(actor: string) {
  const db = getDb();
  const [profiles, invitations] = await Promise.all([
    db
      .select(supervisionProfilesFields)
      .from(supervisionProfiles)
      .where(
        or(
          eq(supervisionProfiles.childAccountId, actor),
          and(
            eq(supervisionProfiles.guardianAccountId, actor),
            ne(supervisionProfiles.status, 'ended'),
          ),
        ),
      ),
    db
      .select(supervisionInvitationsFields)
      .from(supervisionInvitations)
      .where(
        and(
          or(
            eq(supervisionInvitations.childAccountId, actor),
            eq(supervisionInvitations.guardianAccountId, actor),
          ),
          eq(supervisionInvitations.status, 'pending'),
          gt(supervisionInvitations.expiresAt, new Date()),
        ),
      )
      .limit(100),
  ]);
  const self = profiles.find((p) => p.childAccountId === actor);
  return {
    self: self ? profileDto(self) : null,
    children: profiles.filter((p) => p.guardianAccountId === actor).map(profileDto),
    invitations: invitations.map(invitationDto),
  };
}
export async function inviteGuardian(child: string, guardian: string) {
  if (child === guardian) throw forbidden();
  const invitation = await getDb().transaction(async (tx) => {
    await lockPeople(tx, [child, guardian]);
    const [guardianPolicy] = await tx
      .select(supervisionProfilesFields)
      .from(supervisionProfiles)
      .where(
        and(
          eq(supervisionProfiles.childAccountId, guardian),
          ne(supervisionProfiles.status, 'ended'),
        ),
      );
    const [childDependents] = await tx
      .select(supervisionProfilesFields)
      .from(supervisionProfiles)
      .where(
        and(
          eq(supervisionProfiles.guardianAccountId, child),
          ne(supervisionProfiles.status, 'ended'),
        ),
      )
      .limit(1);
    if (guardianPolicy || childDependents) throw forbidden();
    await tx
      .update(supervisionInvitations)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(supervisionInvitations.childAccountId, child),
          eq(supervisionInvitations.status, 'pending'),
          lte(supervisionInvitations.expiresAt, new Date()),
        ),
      );
    const existing = await tx
      .select(supervisionInvitationsFields)
      .from(supervisionInvitations)
      .where(
        and(
          or(
            eq(supervisionInvitations.childAccountId, child),
            eq(supervisionInvitations.guardianAccountId, guardian),
          ),
          eq(supervisionInvitations.status, 'pending'),
          gt(supervisionInvitations.expiresAt, new Date()),
        ),
      )
      .limit(100);
    const same = existing.find(
      (r) => r.childAccountId === child && r.guardianAccountId === guardian,
    );
    if (same) return invitationDto(same);
    if (existing.length >= 100) throw limit();
    // The invitation is not active supervision, but opting into this flow makes the account private immediately.
    await tx.update(users).set({ privacyIsPrivateAccount: true }).where(eq(users.id, child));
    const [row] = await tx
      .insert(supervisionInvitations)
      .values({
        childAccountId: child,
        guardianAccountId: guardian,
        consentVersion: '1',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
      .returning();
    if (!row) throw conflict();
    await audit(tx, child, child, 'invitation_created', { relatedAccountId: guardian });
    return invitationDto(row);
  });
  userCache.invalidate(child);
  return invitation;
}
export async function cancelInvitation(id: string, actor: string) {
  const [row] = await getDb()
    .update(supervisionInvitations)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(supervisionInvitations.id, id),
        eq(supervisionInvitations.status, 'pending'),
        or(
          eq(supervisionInvitations.childAccountId, actor),
          eq(supervisionInvitations.guardianAccountId, actor),
        ),
      ),
    )
    .returning();
  if (!row) throw missing();
  await audit(getDb(), row.childAccountId, actor, 'invitation_cancelled');
}
async function invalidateGuardianApprovals(tx: DatabaseOrTransaction, child: string) {
  await tx.delete(supervisionContacts).where(eq(supervisionContacts.childAccountId, child));
  await tx
    .update(supervisionPurchaseApprovals)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(supervisionPurchaseApprovals.childAccountId, child),
        inArray(supervisionPurchaseApprovals.status, ['pending', 'approved']),
      ),
    );
}
export async function acceptInvitation(id: string, guardian: string) {
  // Ended inside the transaction, announced once it committed.
  const revoked: RevokedSession[] = [];
  const child = await getDb().transaction(async (tx) => {
    const [candidate] = await tx
      .select(supervisionInvitationsFields)
      .from(supervisionInvitations)
      .where(
        and(
          eq(supervisionInvitations.id, id),
          eq(supervisionInvitations.guardianAccountId, guardian),
        ),
      );
    if (!candidate) throw missing();
    await lockPeople(tx, [candidate.childAccountId, guardian]);
    const [invitation] = await tx
      .select(supervisionInvitationsFields)
      .from(supervisionInvitations)
      .where(eq(supervisionInvitations.id, id))
      .for('update');
    if (!invitation || invitation.status !== 'pending' || invitation.expiresAt <= new Date())
      throw conflict();
    const relevant = await tx
      .select(supervisionProfilesFields)
      .from(supervisionProfiles)
      .where(
        or(
          inArray(supervisionProfiles.childAccountId, [candidate.childAccountId, guardian]),
          eq(supervisionProfiles.guardianAccountId, candidate.childAccountId),
          eq(supervisionProfiles.guardianAccountId, guardian),
        ),
      );
    if (
      relevant.some(
        (p) =>
          p.status !== 'ended' &&
          (p.childAccountId === guardian || p.guardianAccountId === candidate.childAccountId),
      )
    )
      throw forbidden();
    if (
      relevant.filter((p) => p.status !== 'ended' && p.guardianAccountId === guardian).length >= 100
    )
      throw limit();
    const existing = relevant.find((p) => p.childAccountId === candidate.childAccountId);
    await tx
      .update(supervisionInvitations)
      .set({ status: 'accepted', acceptedAt: new Date() })
      .where(eq(supervisionInvitations.id, id));
    if (!existing || existing.status === 'ended') {
      const now = new Date();
      await invalidateGuardianApprovals(tx, candidate.childAccountId);
      await tx
        .insert(supervisionProfiles)
        .values({
          childAccountId: candidate.childAccountId,
          guardianAccountId: guardian,
          consentVersion: '1',
          sessionsValidAfter: now,
        })
        .onConflictDoUpdate({
          target: supervisionProfiles.childAccountId,
          set: {
            guardianAccountId: guardian,
            status: 'active',
            consentVersion: '1',
            sessionsValidAfter: now,
          },
        });
      await tx
        .update(users)
        .set({ privacyIsPrivateAccount: true })
        .where(eq(users.id, candidate.childAccountId));
      revoked.push(
        ...(await deactivateSessionRows(
          tx,
          or(
            eq(sessions.userId, candidate.childAccountId),
            eq(sessions.operatedByUserId, candidate.childAccountId),
          ),
        )),
      );
      await audit(tx, candidate.childAccountId, guardian, 'supervision_activated', {
        relatedAccountId: guardian,
      });
    } else {
      // New guardian consent never transfers authority without independent reviewed evidence.
      await audit(tx, candidate.childAccountId, guardian, 'transfer_consent_recorded', {
        relatedAccountId: guardian,
      });
    }
    return candidate.childAccountId;
  });
  announceSessionRevocations(revoked);
  announceUserSessionsRevoked(child);
  userCache.invalidate(child);
  invalidateSupervision(child);
  return getSupervisionState(guardian);
}
export async function listContacts(child: string, actor: string) {
  const [profile] = await getDb()
    .select(supervisionProfilesFields)
    .from(supervisionProfiles)
    .where(eq(supervisionProfiles.childAccountId, child));
  if (!profile || (actor !== child && actor !== profile.guardianAccountId)) throw forbidden();
  const rows = await getDb()
    .select(supervisionContactsFields)
    .from(supervisionContacts)
    .where(eq(supervisionContacts.childAccountId, child))
    .orderBy(asc(supervisionContacts.contactAccountId))
    .limit(1000);
  return {
    items: rows.map((r) => ({
      childAccountId: child,
      contactAccountId: r.contactAccountId,
      approvedAt: r.approvedAt.toISOString(),
    })),
  };
}
export async function changeContact(
  child: string,
  contact: string,
  actor: string,
  approve: boolean,
) {
  if (child === contact) throw forbidden();
  await getDb().transaction(async (tx) => {
    await lockPeople(tx, [child, actor, contact]);
    await assertGuardian(tx, child, actor);
    if (approve) {
      const existing = await tx
        .select({ id: supervisionContacts.contactAccountId })
        .from(supervisionContacts)
        .where(eq(supervisionContacts.childAccountId, child))
        .limit(1000);
      if (existing.length >= 1000 && !existing.some((c) => c.id === contact)) throw limit();
      await tx
        .insert(supervisionContacts)
        .values({ childAccountId: child, contactAccountId: contact, approvedByAccountId: actor })
        .onConflictDoNothing();
    } else
      await tx
        .delete(supervisionContacts)
        .where(
          and(
            eq(supervisionContacts.childAccountId, child),
            eq(supervisionContacts.contactAccountId, contact),
          ),
        );
    await audit(tx, child, actor, approve ? 'contact_approved' : 'contact_revoked', {
      relatedAccountId: contact,
    });
  });
}
export async function reviewSupervision(actor: string, input: SupervisionReviewInput) {
  await getDb().transaction(async (tx) => {
    const [staff] = await tx
      .select({ isStaff: users.isStaff })
      .from(users)
      .where(
        and(eq(users.id, actor), eq(users.accountStatus, 'active'), eq(users.kind, 'personal')),
      );
    if (!staff?.isStaff || actor === input.childAccountId || actor === input.guardianAccountId)
      throw forbidden();
    await lockPeople(tx, [
      input.childAccountId,
      ...(input.guardianAccountId ? [input.guardianAccountId] : []),
    ]);
    const [profile] = await tx
      .select(supervisionProfilesFields)
      .from(supervisionProfiles)
      .where(eq(supervisionProfiles.childAccountId, input.childAccountId))
      .for('update');
    if (!profile || profile.status === 'ended' || profile.guardianAccountId === actor)
      throw forbidden();
    if (input.action === 'transfer') {
      if (!input.guardianAccountId) throw conflict();
      const [consent] = await tx
        .select(supervisionInvitationsFields)
        .from(supervisionInvitations)
        .where(
          and(
            eq(supervisionInvitations.childAccountId, input.childAccountId),
            eq(supervisionInvitations.guardianAccountId, input.guardianAccountId),
            eq(supervisionInvitations.status, 'accepted'),
            gt(supervisionInvitations.acceptedAt, profile.updatedAt),
            gt(supervisionInvitations.expiresAt, new Date()),
          ),
        )
        .limit(1);
      const [supervisedGuardian] = await tx
        .select(supervisionProfilesFields)
        .from(supervisionProfiles)
        .where(
          and(
            eq(supervisionProfiles.childAccountId, input.guardianAccountId),
            ne(supervisionProfiles.status, 'ended'),
          ),
        );
      if (!consent || supervisedGuardian) throw conflict();
      const dependents = await tx
        .select({ child: supervisionProfiles.childAccountId })
        .from(supervisionProfiles)
        .where(
          and(
            eq(supervisionProfiles.guardianAccountId, input.guardianAccountId),
            ne(supervisionProfiles.status, 'ended'),
          ),
        )
        .limit(100);
      if (dependents.length >= 100 && !dependents.some((p) => p.child === input.childAccountId))
        throw limit();
      await tx
        .update(supervisionProfiles)
        .set({ guardianAccountId: input.guardianAccountId, status: 'active' })
        .where(eq(supervisionProfiles.childAccountId, input.childAccountId));
    } else
      await tx
        .update(supervisionProfiles)
        .set({ status: 'ended' })
        .where(eq(supervisionProfiles.childAccountId, input.childAccountId));
    await invalidateGuardianApprovals(tx, input.childAccountId);
    await audit(tx, input.childAccountId, actor, `supervision_${input.action}`, {
      relatedAccountId: input.guardianAccountId,
      evidenceReference: input.evidenceReference,
    });
  });
  invalidateSupervision(input.childAccountId);
}
function purchaseSummaryDto(row: typeof supervisionPurchaseApprovals.$inferSelect) {
  return purchaseApprovalSummarySchema.parse({
    id: row.id,
    childAccountId: row.childAccountId,
    applicationId: row.applicationId,
    operationId: row.operationId,
    resourceId: row.resourceId,
    cartFingerprint: row.cartFingerprint,
    summary: row.summary,
    shippingMinor: row.shippingMinor,
    taxMinor: row.taxMinor,
    discountMinor: row.discountMinor,
    roundingAdjustmentMinor: row.roundingAdjustmentMinor,
    merchantAccountIds: row.merchantAccountIds,
    paymentFingerprint: row.paymentFingerprint,
    amountMinor: row.amountMinor,
    currency: row.currency,
    expiresAt: row.expiresAt.toISOString(),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    receiptReference: row.receiptReference,
  });
}
async function purchaseDto(
  row: typeof supervisionPurchaseApprovals.$inferSelect,
  db: DatabaseOrTransaction = getDb(),
) {
  const lines = await db
    .select({
      itemReference: supervisionPurchaseLines.itemReference,
      title: supervisionPurchaseLines.title,
      optionsText: supervisionPurchaseLines.optionsText,
      merchantAccountId: supervisionPurchaseLines.merchantAccountId,
      quantity: supervisionPurchaseLines.quantity,
      unitAmountMinor: supervisionPurchaseLines.unitAmountMinor,
      lineAmountMinor: supervisionPurchaseLines.lineAmountMinor,
    })
    .from(supervisionPurchaseLines)
    .where(eq(supervisionPurchaseLines.approvalId, row.id))
    .orderBy(asc(supervisionPurchaseLines.position));
  return purchaseApprovalSchema.parse({ ...purchaseSummaryDto(row), lineItems: lines });
}
function sameEffects(row: Awaited<ReturnType<typeof purchaseDto>>, input: PurchaseEffects) {
  return (
    row.operationId === input.operationId &&
    row.resourceId === input.resourceId &&
    row.cartFingerprint === input.cartFingerprint &&
    row.summary === input.summary &&
    row.shippingMinor === input.shippingMinor &&
    row.taxMinor === input.taxMinor &&
    row.discountMinor === input.discountMinor &&
    row.roundingAdjustmentMinor === input.roundingAdjustmentMinor &&
    JSON.stringify(row.lineItems) === JSON.stringify(input.lineItems) &&
    JSON.stringify(row.merchantAccountIds) ===
      JSON.stringify([...input.merchantAccountIds].sort()) &&
    row.paymentFingerprint === input.paymentFingerprint &&
    row.amountMinor === input.amountMinor &&
    row.currency === input.currency &&
    row.expiresAt === new Date(input.expiresAt).toISOString()
  );
}
export async function requestPurchase(app: string, child: string, rawInput: PurchaseEffects) {
  const input = purchaseEffectsSchema.parse(rawInput);
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`purchase:${app}:${input.operationId}`},0))`,
    );
    const [existing] = await tx
      .select(supervisionPurchaseApprovalsFields)
      .from(supervisionPurchaseApprovals)
      .where(
        and(
          eq(supervisionPurchaseApprovals.applicationId, app),
          eq(supervisionPurchaseApprovals.operationId, input.operationId),
        ),
      );
    if (existing) {
      if (existing.childAccountId !== child || !sameEffects(await purchaseDto(existing, tx), input))
        throw conflict();
      return purchaseDto(existing, tx);
    }
    const [profile] = await tx
      .select(supervisionProfilesFields)
      .from(supervisionProfiles)
      .where(eq(supervisionProfiles.childAccountId, child))
      .for('update');
    if (profile?.status !== 'active' || !profile.guardianAccountId) throw forbidden();
    const expiry = new Date(input.expiresAt);
    if (expiry <= new Date() || expiry.getTime() > Date.now() + 7 * 86400000)
      throw new SafetyError(
        422,
        'validation_failed',
        'Purchase approval expires within seven days',
      );
    const { lineItems, ...effects } = input;
    const [row] = await tx
      .insert(supervisionPurchaseApprovals)
      .values({
        ...effects,
        merchantAccountIds: [...input.merchantAccountIds].sort(),
        childAccountId: child,
        applicationId: app,
        expiresAt: expiry,
      })
      .returning();
    if (!row) throw conflict();
    await tx
      .insert(supervisionPurchaseLines)
      .values(lineItems.map((line, position) => ({ ...line, approvalId: row.id, position })));
    await tx
      .update(supervisionPurchaseApprovals)
      .set({ evidenceSealed: true })
      .where(eq(supervisionPurchaseApprovals.id, row.id));
    await audit(tx, child, child, 'purchase_requested', { applicationId: app, resourceId: row.id });
    return purchaseDto(row, tx);
  });
}
export async function listPurchases(actor: string, cursor?: string) {
  const children = await getDb()
    .select({ id: supervisionProfiles.childAccountId })
    .from(supervisionProfiles)
    .where(
      and(
        eq(supervisionProfiles.guardianAccountId, actor),
        eq(supervisionProfiles.status, 'active'),
      ),
    );
  const rows = await getDb()
    .select(supervisionPurchaseApprovalsFields)
    .from(supervisionPurchaseApprovals)
    .where(
      and(
        inArray(supervisionPurchaseApprovals.childAccountId, [actor, ...children.map((c) => c.id)]),
        cursor ? lt(supervisionPurchaseApprovals.id, cursor) : undefined,
      ),
    )
    .orderBy(desc(supervisionPurchaseApprovals.id))
    .limit(101);
  return {
    items: rows.slice(0, 100).map(purchaseSummaryDto),
    nextCursor: rows.length > 100 ? rows[99].id : null,
  };
}
export async function getPurchase(id: string, actor: string) {
  const [row] = await getDb()
    .select(supervisionPurchaseApprovalsFields)
    .from(supervisionPurchaseApprovals)
    .where(eq(supervisionPurchaseApprovals.id, id));
  if (!row) throw missing();
  if (row.childAccountId !== actor) {
    const [profile] = await getDb()
      .select({
        guardian: supervisionProfiles.guardianAccountId,
        status: supervisionProfiles.status,
      })
      .from(supervisionProfiles)
      .where(eq(supervisionProfiles.childAccountId, row.childAccountId));
    if (profile?.status !== 'active' || profile.guardian !== actor) throw missing();
    const [guardian] = await getDb()
      .select({ kind: users.kind, status: users.accountStatus, reputation: users.reputationTier })
      .from(users)
      .where(eq(users.id, actor));
    if (
      !guardian ||
      guardian.kind !== 'personal' ||
      guardian.status !== 'active' ||
      guardian.reputation === 'restricted'
    )
      throw missing();
  }
  return purchaseDto(row);
}
export async function reviewPurchase(id: string, actor: string, decision: 'approved' | 'rejected') {
  return getDb().transaction(async (tx) => {
    const [candidate] = await tx
      .select({ child: supervisionPurchaseApprovals.childAccountId })
      .from(supervisionPurchaseApprovals)
      .where(eq(supervisionPurchaseApprovals.id, id));
    if (!candidate) throw missing();
    await tx
      .select({ child: supervisionProfiles.childAccountId })
      .from(supervisionProfiles)
      .where(eq(supervisionProfiles.childAccountId, candidate.child))
      .for('update');
    const [row] = await tx
      .select(supervisionPurchaseApprovalsFields)
      .from(supervisionPurchaseApprovals)
      .where(eq(supervisionPurchaseApprovals.id, id))
      .for('update');
    if (!row) throw missing();
    await assertGuardian(tx, row.childAccountId, actor);
    if (row.status !== 'pending' || row.expiresAt <= new Date()) throw conflict();
    const [updated] = await tx
      .update(supervisionPurchaseApprovals)
      .set({ status: decision, reviewedByAccountId: actor, reviewedAt: new Date() })
      .where(eq(supervisionPurchaseApprovals.id, id))
      .returning();
    if (!updated) throw conflict();
    await audit(tx, row.childAccountId, actor, `purchase_${decision}`, { resourceId: id });
    return purchaseDto(updated, tx);
  });
}
export async function reservePurchase(app: string, rawInput: ReservePurchase) {
  const input = reservePurchaseSchema.parse(rawInput);
  return getDb().transaction(async (tx) => {
    const [candidate] = await tx
      .select({ child: supervisionPurchaseApprovals.childAccountId })
      .from(supervisionPurchaseApprovals)
      .where(eq(supervisionPurchaseApprovals.id, input.approvalId));
    if (!candidate) throw missing();
    await tx
      .select({ child: supervisionProfiles.childAccountId })
      .from(supervisionProfiles)
      .where(eq(supervisionProfiles.childAccountId, candidate.child))
      .for('update');
    const [row] = await tx
      .select(supervisionPurchaseApprovalsFields)
      .from(supervisionPurchaseApprovals)
      .where(
        and(
          eq(supervisionPurchaseApprovals.id, input.approvalId),
          eq(supervisionPurchaseApprovals.applicationId, app),
        ),
      )
      .for('update');
    if (!row) throw missing();
    if (!sameEffects(await purchaseDto(row, tx), input)) throw conflict();
    if (row.status === 'reserved' || row.status === 'confirmed') return purchaseDto(row, tx);
    if (row.status !== 'approved' || row.expiresAt <= new Date() || !row.reviewedByAccountId)
      throw conflict();
    await assertGuardian(tx, row.childAccountId, row.reviewedByAccountId);
    const [updated] = await tx
      .update(supervisionPurchaseApprovals)
      .set({ status: 'reserved', reservedAt: new Date() })
      .where(eq(supervisionPurchaseApprovals.id, row.id))
      .returning();
    if (!updated) throw conflict();
    await audit(tx, row.childAccountId, null, 'purchase_reserved', {
      applicationId: app,
      resourceId: row.id,
    });
    return purchaseDto(updated, tx);
  });
}
export async function finishPurchase(
  app: string,
  input: ConfirmPurchase | CancelPurchase,
  confirm: boolean,
) {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .select(supervisionPurchaseApprovalsFields)
      .from(supervisionPurchaseApprovals)
      .where(
        and(
          eq(supervisionPurchaseApprovals.id, input.approvalId),
          eq(supervisionPurchaseApprovals.applicationId, app),
          eq(supervisionPurchaseApprovals.operationId, input.operationId),
        ),
      )
      .for('update');
    if (!row) throw missing();
    const receipt = 'receiptReference' in input ? input.receiptReference : null;
    if (row.status === (confirm ? 'confirmed' : 'cancelled')) {
      if (confirm && row.receiptReference !== receipt) throw conflict();
      return purchaseDto(row, tx);
    }
    if (
      confirm
        ? row.status !== 'reserved'
        : !['pending', 'approved', 'reserved'].includes(row.status)
    )
      throw conflict();
    const [updated] = await tx
      .update(supervisionPurchaseApprovals)
      .set({ status: confirm ? 'confirmed' : 'cancelled', receiptReference: receipt })
      .where(eq(supervisionPurchaseApprovals.id, row.id))
      .returning();
    if (!updated) throw conflict();
    await audit(
      tx,
      row.childAccountId,
      null,
      confirm ? 'purchase_confirmed' : 'purchase_cancelled',
      { applicationId: app, resourceId: row.id },
    );
    return purchaseDto(updated, tx);
  });
}

/** Only the identity needed to choose or recognize supervision participants. */
export async function supervisionPeople(actor: string, input: SafetyPeopleInput) {
  const publicPerson = and(
    eq(users.privacyIsPrivateAccount, false),
    eq(users.privacyProfileVisibility, true),
  );
  const related = sql`(
    ${users.id} = ${actor}
    or exists (select 1 from ${supervisionProfiles} p
      where p.status <> 'ended' and (${actor} in (p.child_account_id, p.guardian_account_id))
      and ${users.id} in (p.child_account_id, p.guardian_account_id))
    or exists (select 1 from ${supervisionInvitations} i
      where i.status = 'pending' and i.expires_at > now()
      and ${actor} in (i.child_account_id, i.guardian_account_id)
      and ${users.id} in (i.child_account_id, i.guardian_account_id))
    or exists (select 1 from ${supervisionContacts} c join ${supervisionProfiles} p
      on p.child_account_id = c.child_account_id and p.status = 'active'
      where ${actor} in (p.child_account_id, p.guardian_account_id)
      and c.contact_account_id = ${users.id})
    or exists (select 1 from ${supervisionPurchaseApprovals} a
      left join ${supervisionProfiles} p on p.child_account_id = a.child_account_id and p.status = 'active'
      where (${actor} = a.child_account_id or ${actor} = p.guardian_account_id)
      and ${users.id} = any(a.merchant_account_ids))
  )`;
  const selection =
    'query' in input
      ? and(
          eq(users.kind, 'personal'),
          eq(users.privacyProfileVisibility, true),
          or(
            and(
              publicPerson,
              sql`${users.username} ilike ${input.query.replace(/[\\%_]/g, '\\$&') + '%'}`,
            ),
            sql`lower(btrim(${users.username})) = lower(btrim(${input.query}))`,
          ),
        )
      : and(inArray(users.id, input.accountIds), or(publicPerson, related));
  const items = await getDb()
    .select({ accountId: users.id, username: users.username, displayName: users.nameDisplay })
    .from(users)
    .where(
      and(
        eq(users.accountStatus, 'active'),
        ne(users.reputationTier, 'restricted'),
        visibleOrganizationIdentityPredicate(),
        selection,
        sql`not exists (select 1 from ${blocks} b where (b.user_id = ${actor} and b.blocked_id = ${users.id}) or (b.blocked_id = ${actor} and b.user_id = ${users.id}))`,
      ),
    )
    .orderBy(
      ...('query' in input
        ? [
            sql`case when lower(btrim(${users.username})) = lower(btrim(${input.query})) then 0 else 1 end`,
          ]
        : []),
      asc(users.username),
      asc(users.id),
    )
    .limit('query' in input ? 20 : 100);
  return { items };
}
