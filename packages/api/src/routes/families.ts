/**
 * `/families` — Oxy Family membership (backend-only for this pass; no
 * frontend/UI work here). See `db/schema/families.ts` for the schema design
 * decision and `services/family.service.ts` for the business rules this
 * router only validates input for and gates.
 */

import express from 'express';
import type { Request } from 'express';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimiter';
import { hashedIpKey } from '../utils/ipKey';
import { asyncHandler } from '../utils/asyncHandler';
import { NotFoundError } from '../utils/error';
import { resolveOperatorId } from '../middleware/operator';
import { resolveUserByIdentifier } from '../utils/resolveUserIdentifier';
import { familyService, type FamilyMemberRow, type FamilyRow } from '../services/family.service';
import {
  createFamilySchema,
  familyIdRouteParams,
  familyMemberParams,
  inviteFamilyMemberSchema,
} from '../schemas/family.schemas';

const router = express.Router();

// Every family route requires an authenticated user — there is no
// service-scoped or public surface here, unlike `routes/accounts.ts`.
router.use(authMiddleware);

/** Per-user (or per-IP when anonymous) rate-limit key for a scope. */
function userScopedKey(scope: string) {
  return (req: Request): string => {
    const userId = (req as AuthRequest).user?._id?.toString();
    return userId ? `${scope}:${userId}` : `${scope}:ip:${hashedIpKey(req)}`;
  };
}

const readLimiter = rateLimit({
  prefix: 'rl:families:read:',
  windowMs: 60 * 1000,
  max: 240,
  message: 'Too many family requests. Please slow down.',
  keyGenerator: userScopedKey('families:read'),
});

const writeLimiter = rateLimit({
  prefix: 'rl:families:write:',
  windowMs: 60 * 1000,
  max: 60,
  message: 'Too many family changes. Please slow down.',
  keyGenerator: userScopedKey('families:write'),
});

/** Serialise a `family_members` row for client responses. */
function serializeMember(member: FamilyMemberRow) {
  return {
    id: member.id,
    familyId: member.familyId,
    memberUserId: member.memberUserId,
    role: member.role,
    status: member.status,
    invitedByUserId: member.invitedByUserId ?? undefined,
    joinedAt: member.joinedAt ?? undefined,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
  };
}

/** Serialise a `families` row for client responses. */
function serializeFamily(family: FamilyRow) {
  return {
    id: family.id,
    name: family.name ?? undefined,
    createdAt: family.createdAt,
    updatedAt: family.updatedAt,
  };
}

/** POST /families — create a family. The caller becomes its organizer. */
router.post(
  '/',
  writeLimiter,
  validate({ body: createFamilySchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const operatorId = await resolveOperatorId(req);
    const { name } = req.body as { name?: string };

    const { family, membership } = await familyService.createFamily(operatorId, name);
    res.status(201).json({
      family: serializeFamily(family),
      membership: serializeMember(membership),
    });
  })
);

/** GET /families/me — the caller's family and its roster, or 404 when they belong to none. */
router.get(
  '/me',
  readLimiter,
  asyncHandler(async (req: AuthRequest, res) => {
    const operatorId = await resolveOperatorId(req);
    const roster = await familyService.getMyFamily(operatorId);
    if (!roster) {
      throw new NotFoundError('You do not belong to a family');
    }
    res.json({
      family: serializeFamily(roster.family),
      members: roster.members.map(serializeMember),
    });
  })
);

/** GET /families/invites — pending invites addressed to the caller. */
router.get(
  '/invites',
  readLimiter,
  asyncHandler(async (req: AuthRequest, res) => {
    const operatorId = await resolveOperatorId(req);
    const invites = await familyService.listPendingInvites(operatorId);
    res.json({
      invites: invites.map(({ membership, family }) => ({
        membership: serializeMember(membership),
        family: serializeFamily(family),
      })),
    });
  })
);

/** POST /families/:id/members — invite a user by username/email. Organizer only. */
router.post(
  '/:id/members',
  writeLimiter,
  validate({ params: familyIdRouteParams, body: inviteFamilyMemberSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const operatorId = await resolveOperatorId(req);
    const { usernameOrEmail } = req.body as { usernameOrEmail: string };

    const targetUser = await resolveUserByIdentifier(usernameOrEmail);
    if (!targetUser) {
      throw new NotFoundError('User not found');
    }

    const member = await familyService.inviteMember(req.params.id, operatorId, targetUser.id);
    res.status(201).json({ member: serializeMember(member) });
  })
);

/** POST /families/:id/members/:memberId/accept — accept your own pending invite. */
router.post(
  '/:id/members/:memberId/accept',
  writeLimiter,
  validate({ params: familyMemberParams }),
  asyncHandler(async (req: AuthRequest, res) => {
    const operatorId = await resolveOperatorId(req);
    const member = await familyService.acceptInvite(
      req.params.id,
      req.params.memberId,
      operatorId
    );
    res.json({ member: serializeMember(member) });
  })
);

/** POST /families/:id/members/:memberId/decline — decline your own pending invite. */
router.post(
  '/:id/members/:memberId/decline',
  writeLimiter,
  validate({ params: familyMemberParams }),
  asyncHandler(async (req: AuthRequest, res) => {
    const operatorId = await resolveOperatorId(req);
    await familyService.declineInvite(req.params.id, req.params.memberId, operatorId);
    res.json({ success: true });
  })
);

/** DELETE /families/:id/members/:memberId — remove another member. Organizer only. */
router.delete(
  '/:id/members/:memberId',
  writeLimiter,
  validate({ params: familyMemberParams }),
  asyncHandler(async (req: AuthRequest, res) => {
    const operatorId = await resolveOperatorId(req);
    await familyService.removeMember(req.params.id, req.params.memberId, operatorId);
    res.json({ success: true });
  })
);

/** POST /families/:id/leave — leave the family (organizer only when the sole active member). */
router.post(
  '/:id/leave',
  writeLimiter,
  validate({ params: familyIdRouteParams }),
  asyncHandler(async (req: AuthRequest, res) => {
    const operatorId = await resolveOperatorId(req);
    await familyService.leaveFamily(req.params.id, operatorId);
    res.json({ success: true });
  })
);

export default router;
