import { z } from 'zod';
import { identityProofSchema, webauthnAssertionResponseSchema } from '@oxy.so/contracts';

// POST /auth/link — first link of a root only (ADR 0024 D8). Passkeys register
// via the WebAuthn ceremony, not this route.
export const linkAuthMethodSchema = z
  .object({
    type: z.literal('identity'),
    publicKey: z.string().trim().min(1),
    proof: identityProofSchema,
    /** A fresh assertion by an existing passkey over `proof.challenge`; required for a keyless account. */
    assertion: webauthnAssertionResponseSchema.optional(),
  })
  .strict();
export type LinkAuthMethodBody = z.infer<typeof linkAuthMethodSchema>;

// DELETE /auth/link/webauthn/:credentialID
export const unlinkWebauthnParams = z.object({
  credentialID: z.string().trim().min(1),
});
