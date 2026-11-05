import { utf16MaxLength, utf16MinLength } from '@oxy.so/contracts';
import { z } from 'zod';

/** Route params with :id (the family id). */
export const familyIdRouteParams = z.object({
  id: z.string().trim().check(utf16MinLength(1)),
});

/** Route params with :id and :memberId (a `family_members` row id). */
export const familyMemberParams = z.object({
  id: z.string().trim().check(utf16MinLength(1)),
  memberId: z.string().trim().check(utf16MinLength(1)),
});

/** POST /families — create a family. `name` is an optional display name. */
export const createFamilySchema = z.object({
  name: z.string().trim().check(utf16MinLength(1)).check(utf16MaxLength(100)).optional(),
});

/**
 * POST /families/:id/members — invite a user to the family by username or
 * email. Unlike `account_members`, there is no `role` to choose: every invitee
 * joins as a plain `member`, and organizer is granted only at family creation
 * (there is no transfer-ownership endpoint in this pass).
 */
export const inviteFamilyMemberSchema = z.object({
  usernameOrEmail: z.string().trim().check(utf16MinLength(1)),
});
