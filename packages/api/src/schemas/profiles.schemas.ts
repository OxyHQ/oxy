import { utf16MaxLength, utf16MinLength } from '@oxy.so/contracts';
import { z } from 'zod';
import { ACCOUNT_KINDS, USER_TYPES } from '../db/schema/users';

// GET /profiles/username/:username
export const usernameParams = z.object({
  username: z.string().trim().check(utf16MinLength(3)).check(utf16MaxLength(100)),
});

// GET /profiles/search
//
// `type` and `kind` narrow the result to rows whose own `type` / `kind` equals
// the value (`type=local` is "Oxy accounts only", what a messaging app's
// new-chat picker wants). One value each; an unknown value is a 400.
export const profileSearchQuerySchema = z.object({
  query: z.string().trim().check(utf16MinLength(1)),
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
  type: z.enum(USER_TYPES).optional(),
  kind: z.enum(ACCOUNT_KINDS).optional(),
});

// GET /profiles/recommendations
export const paginationQuerySchema = z.object({
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
});
