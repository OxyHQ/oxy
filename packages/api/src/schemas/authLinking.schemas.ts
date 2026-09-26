import { z } from 'zod';
import { identityProofSchema } from '@oxy.so/contracts';

// POST /auth/link — a root proof for an account whose root is this key
// (ADR 0024 D8); a keyless account links through `routes/identityLink.ts`.
export const linkAuthMethodSchema = z
  .object({
    type: z.literal('identity'),
    publicKey: z.string().trim().min(1),
    proof: identityProofSchema,
  })
  .strict();
export type LinkAuthMethodBody = z.infer<typeof linkAuthMethodSchema>;
