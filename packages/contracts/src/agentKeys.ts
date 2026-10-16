/** Autonomous runtime proof. No private key crosses this contract. */
import { z } from 'zod';
import { reauthProofSchema } from './signIn';
import { canonicalJson } from './identityProof';
// The Zod-free half of this contract lives in `./client/` (`@oxy.so/contracts/client`);
// it is re-exported here so the root entry is unchanged.
import { AGENT_PROOF_AUDIENCE, AGENT_PROOF_ACTIONS } from './client/agentKeys';
export {
  AGENT_PROOF_AUDIENCE,
  AGENT_PROOF_TTL_MS,
  AGENT_PROOF_ACTIONS,
  ACCOUNT_AUTH_METHODS,
} from './client/agentKeys';
export type { AgentProofAction, AccountAuthMethod } from './client/agentKeys';

export const agentProofClaimsSchema = z
  .object({
    version: z.literal(1),
    audience: z.literal(AGENT_PROOF_AUDIENCE),
    action: z.enum(AGENT_PROOF_ACTIONS),
    accountId: z.string().min(1),
    actorId: z.string().min(1),
    authMethodId: z.string().nullable(),
    publicKey: z.string().min(1),
    payloadDigest: z.string().regex(/^[0-9a-f]{64}$/),
    challenge: z.string().regex(/^[0-9a-f]{64}$/),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type AgentProofClaims = z.infer<typeof agentProofClaimsSchema>;

/** Different proof roles cannot substitute for one another on the same operation. */
export function buildAgentProofMessage(
  claims: AgentProofClaims,
  timestamp: number,
  role: 'credential' | 'governor' = 'credential',
): string {
  return canonicalJson({
    domain: 'oxy-agent-proof',
    ...agentProofClaimsSchema.parse(claims),
    timestamp,
    role,
  });
}

export const agentSignatureSchema = z
  .object({
    challenge: z.string().regex(/^[0-9a-f]{64}$/),
    signature: z
      .string()
      .regex(/^[0-9a-f]+$/i)
      .max(160),
    timestamp: z.number().int().positive(),
  })
  .strict();
export type AgentSignature = z.infer<typeof agentSignatureSchema>;
export const agentChallengeRequestSchema = z
  .object({ publicKey: z.string().trim().min(1).max(130) })
  .strict();
export type AgentChallengeRequest = z.infer<typeof agentChallengeRequestSchema>;
export const agentVerifyRequestSchema = agentSignatureSchema
  .extend({ publicKey: z.string().trim().min(1).max(130) })
  .strict();
export type AgentVerifyRequest = z.infer<typeof agentVerifyRequestSchema>;

const newKey = {
  publicKey: z.string().trim().min(1).max(130),
  label: z.string().trim().min(1).max(120),
};
export const agentKeyOperationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('enroll'), ...newKey }).strict(),
  z.object({ operation: z.literal('recover'), ...newKey }).strict(),
  z
    .object({ operation: z.literal('rotate'), ...newKey, retireCurrent: z.boolean().optional() })
    .strict(),
  z.object({ operation: z.literal('revoke'), methodId: z.string().min(1) }).strict(),
]);
export type AgentKeyOperation = z.infer<typeof agentKeyOperationSchema>;
export const agentKeyOperationProofSchema = z
  .object({
    challenge: z.string().regex(/^[0-9a-f]{64}$/),
    timestamp: z.number().int().positive(),
    keySignature: z
      .string()
      .regex(/^[0-9a-f]+$/i)
      .max(160)
      .optional(),
    governorSignature: z
      .string()
      .regex(/^[0-9a-f]+$/i)
      .max(160)
      .optional(),
    reauth: reauthProofSchema.optional(),
  })
  .strict();
export type AgentKeyOperationProof = z.infer<typeof agentKeyOperationProofSchema>;
export const executeAgentKeyOperationSchema = z
  .object({
    operation: agentKeyOperationSchema,
    proof: agentKeyOperationProofSchema,
  })
  .strict();
export type ExecuteAgentKeyOperation = z.infer<typeof executeAgentKeyOperationSchema>;

export const agentKeyOperationChallengeSchema = z
  .object({
    claims: agentProofClaimsSchema,
    governorPublicKey: z.string().nullable(),
  })
  .strict();
export type AgentKeyOperationChallenge = z.infer<typeof agentKeyOperationChallengeSchema>;
export const agentKeyOperationResultSchema = z
  .object({
    methodId: z.string().nullable(),
    revokedMethodIds: z.array(z.string()),
  })
  .strict();
export type AgentKeyOperationResult = z.infer<typeof agentKeyOperationResultSchema>;
/** Public credential inventory. Never includes a proof, bearer or private key. */
export const agentKeyListResponseSchema = z
  .object({
    keys: z.array(
      z
        .object({
          id: z.string(),
          publicKey: z.string(),
          label: z.string(),
          enrolledByUserId: z.string().nullable(),
          enrollmentMethod: z.enum(['governor', 'rotation', 'recovery']),
          linkedAt: z.string().datetime(),
          lastUsedAt: z.string().datetime().nullable(),
          revokedAt: z.string().datetime().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type AgentKeyListResponse = z.infer<typeof agentKeyListResponseSchema>;
