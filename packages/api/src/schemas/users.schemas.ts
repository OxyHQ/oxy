import { z } from 'zod';
import { emailReauthProofSchema, secondFactorCodeSchema } from '@oxy.so/contracts';
import { privacySettingsSchema } from './privacy.schemas';

// Shared params for routes with :userId
export const userIdParams = z.object({
  userId: z.string().trim().min(1),
});

// POST /users/search
export const searchUsersBodySchema = z.object({
  query: z.string().trim().min(1),
});

// Maximum number of ids accepted by POST /users/by-ids in a single request.
export const MAX_USERS_BY_IDS = 100;

// POST /users/by-ids
export const usersByIdsBodySchema = z.object({
  ids: z
    .array(z.string().trim().min(1))
    .min(1, 'ids must not be empty')
    .max(MAX_USERS_BY_IDS, `Cannot request more than ${MAX_USERS_BY_IDS} users at once`),
});

// POST /users/verify/request
export const verifyRequestSchema = z.object({
  reason: z.string().trim().min(1),
  evidence: z.string().trim().optional(),
});

// DELETE /users/me
// An account with a Commons key signs the deletion with it; an account without
// one confirms with a code emailed for this deletion. Either adds its
// authenticator code when it has one.
export const deleteAccountSchema = z.object({
  signature: z.string().trim().min(1).optional(),
  timestamp: z.number().optional(),
  /** An account without a key: a code just sent to its email (+ its authenticator code). */
  reauth: emailReauthProofSchema.optional(),
  /** An account with a key AND an authenticator: its code or a backup code. */
  totpCode: secondFactorCodeSchema.optional(),
  confirmText: z.string().trim().min(1),
});
export type DeleteAccountBody = z.infer<typeof deleteAccountSchema>;

// GET /users/me/data
export const dataExportQuerySchema = z.object({
  format: z.enum(['json', 'csv']).optional(),
});

// GET /users/me/export — signed self-sovereign data export ("credible exit").
// `ndjson` streams each section as newline-delimited JSON for large accounts.
export const identityExportQuerySchema = z.object({
  format: z.enum(['json', 'ndjson']).optional(),
});

// Pagination query schema
export const paginationQuerySchema = z.object({
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
});

// PUT /users/:userId/privacy
export const updatePrivacyBodySchema = z.object({
  privacySettings: privacySettingsSchema,
});
