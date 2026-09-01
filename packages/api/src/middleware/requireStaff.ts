import { eq } from 'drizzle-orm';
import type { NextFunction, Response } from 'express';
import { getDb } from '../config/postgres';
import { STAFF_CAPABILITIES, users, type StaffCapability } from '../db/schema/users';
import { asyncHandler } from '../utils/asyncHandler';
import type { AuthRequest } from './auth';

/**
 * Platform staff guard.
 *
 * Requires the authenticated user to carry the `isStaff` flag on their User
 * document (set in the DB by a platform administrator only — there is no
 * self-service route to grant it). Used to gate staff-only operations such as
 * editing an Application's `type` / `isOfficial` / `isInternal` / `capabilities`
 * fields, which are NOT grantable through any application membership role.
 *
 * This is the "any staff" gate and it keeps that meaning. The graded surfaces
 * add {@link requireStaffCapability} BEHIND it rather than replacing it, so no
 * existing call site changes meaning by having a new file imported next to it.
 *
 * MUST run after `authMiddleware` so `req.user` is populated.
 */
export const requireStaff = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (req.user?.isStaff === true) {
    next();
    return;
  }
  res.status(403).json({
    error: 'Forbidden',
    message: 'This operation requires Oxy platform staff privileges',
  });
};

/**
 * Predicate form of the staff guard for inline checks inside a handler (e.g.
 * silently ignoring staff-only fields on a normal update path rather than
 * rejecting the whole request).
 */
export const isStaffUser = (req: AuthRequest): boolean => req.user?.isStaff === true;

/**
 * What a caller is told they are missing, per capability (#972 section 12).
 *
 * A TOTAL `Record`, which is the point of {@link STAFF_CAPABILITIES} being a
 * closed tuple: adding a capability without deciding what its refusal says is a
 * compile error, not a 403 reading "requires the  capability".
 */
const CAPABILITY_DESCRIPTIONS: Record<StaffCapability, string> = {
  'inference:catalogue:publish':
    'publishing, restricting or retiring a model route in the inference catalogue',
  'billing:adjust': "adjusting a customer's balance or closing an invoice period",
  'billing:cost_centers': 'registering or retiring an internal cost centre',
};

/**
 * Graded staff guard: staff, AND holding this specific capability.
 *
 * ## Why the capability is read from the database and not from `req.user`
 *
 * `req.user` is an `AccountDocument` served through `userCache`, so a capability
 * read from it can be up to the cache's lifetime stale. For a dashboard that is
 * fine; for the surfaces this guard covers — publishing what Oxy sells, creating
 * customer balance out of nothing — it means a REVOKED capability keeps working
 * for as long as a cache entry lives, and the revocation is the operation whose
 * timing actually matters. One primary-key lookup on a route a handful of staff
 * call is the cheaper side of that trade by a wide margin.
 *
 * It also keeps the grant out of the account document entirely, so no
 * customer-facing serializer, export bundle or session payload has to be audited
 * for having picked it up.
 *
 * ## `is_staff` is checked FIRST, and separately
 *
 * A capability narrows staff; it never substitutes for it. Checking both means a
 * row that somehow acquired a capability without the flag — a bad backfill, a
 * hand-written UPDATE — is refused rather than admitted, and the caller who is
 * not staff at all is told the same thing `requireStaff` would have told them
 * rather than being handed the name of a capability to go and ask for.
 *
 * Wrapped in `asyncHandler` so a database failure answers 500 through the same
 * path every other route does. An unwrapped async middleware rejects into
 * Express's unhandled-rejection lane instead, where the request simply hangs —
 * and a hanging request on a guard reads, from outside, like a slow admin
 * endpoint rather than a broken one.
 */
export const requireStaffCapability = (capability: StaffCapability) => {
  return asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    const userId = req.user?._id;
    if (req.user?.isStaff !== true || typeof userId !== 'string' || userId.length === 0) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'This operation requires Oxy platform staff privileges',
      });
      return;
    }

    const [row] = await getDb()
      .select({ staffCapabilities: users.staffCapabilities, isStaff: users.isStaff })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    // A missing row is refused, not treated as an absent capability list: the
    // authenticated account no longer exists, and `[]` would be the same answer
    // this guard gives a staff member who simply holds nothing.
    if (row === undefined || row.isStaff !== true || !row.staffCapabilities.includes(capability)) {
      res.status(403).json({
        error: 'Forbidden',
        message: `This operation requires the ${capability} staff capability (${CAPABILITY_DESCRIPTIONS[capability]}). Platform staff status alone does not grant it.`,
      });
      return;
    }

    next();
  });
};
