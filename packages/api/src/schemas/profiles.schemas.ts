import { utf16MaxLength, utf16MinLength } from '@oxy.so/contracts';
import { z } from '@oxy.so/zod4';

// GET /profiles/username/:username
export const usernameParams = z.object({
  username: z.string().trim().check(utf16MinLength(3)).check(utf16MaxLength(100)),
});

// GET /profiles/search
export const profileSearchQuerySchema = z.object({
  query: z.string().trim().check(utf16MinLength(1)),
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
});

// GET /profiles/recommendations
export const paginationQuerySchema = z.object({
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
});
