import { z } from 'zod';

/**
 * Schemas for the contact discovery routes (`/contacts/...`).
 *
 * Discovery uploads only opaque SHA-256 hex digests — never raw email or
 * phone. See `utils/contactHash.ts` for the canonical hashing rules the
 * client must use.
 */

/** A single 64-char lowercase hex SHA-256 digest. */
const sha256HexSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-f0-9]{64}$/u, 'Must be a 64-character lowercase SHA-256 hex digest');

/**
 * Hard upper bound on how many hashed identifiers a single request can carry.
 * Combined with the per-user 5-req/min rate limit this caps discovery at
 * 1,000 identifiers per minute per user — enough for the typical address
 * book without enabling mass enumeration.
 */
export const MAX_HASHES_PER_REQUEST = 200;

// POST /contacts/discover
export const discoverContactsSchema = z
  .object({
    hashedEmails: z.array(sha256HexSchema).max(MAX_HASHES_PER_REQUEST).default([]),
    hashedPhones: z.array(sha256HexSchema).max(MAX_HASHES_PER_REQUEST).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.hashedEmails.length === 0 && value.hashedPhones.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one hashedEmail or hashedPhone is required',
        path: ['hashedEmails'],
      });
    }
    if (value.hashedEmails.length + value.hashedPhones.length > MAX_HASHES_PER_REQUEST * 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Total identifiers must not exceed ${MAX_HASHES_PER_REQUEST * 2}`,
        path: ['hashedEmails'],
      });
    }
  });

export type DiscoverContactsBody = z.infer<typeof discoverContactsSchema>;
