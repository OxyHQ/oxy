/** Autonomous runtime proof. No private key crosses this contract. */
import { z } from 'zod';
import { reauthProofSchema } from './signIn';
import { canonicalJson } from './identityProof';

export const AGENT_PROOF_AUDIENCE = 'oxy-api/agent' as const;
export const AGENT_PROOF_TTL_MS = 60_000;
export const AGENT_PROOF_ACTIONS = ['agent_signin', 'agent_enroll', 'agent_rotate', 'agent_recover', 'agent_governance'] as const;
export type AgentProofAction = (typeof AGENT_PROOF_ACTIONS)[number];

export const agentProofClaimsSchema = z.object({
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
}).strict();
export type AgentProofClaims = z.infer<typeof agentProofClaimsSchema>;

/** Different proof roles cannot substitute for one another on the same operation. */
export function buildAgentProofMessage(
    claims: AgentProofClaims,
    timestamp: number,
    role: 'credential' | 'governor' = 'credential',
): string {
    return canonicalJson({ domain: 'oxy-agent-proof', ...agentProofClaimsSchema.parse(claims), timestamp, role });
}

export const agentSignatureSchema = z.object({
    challenge: z.string().regex(/^[0-9a-f]{64}$/),
    signature: z.string().regex(/^[0-9a-f]+$/i).max(160),
    timestamp: z.number().int().positive(),
}).strict();
export type AgentSignature = z.infer<typeof agentSignatureSchema>;
export const agentChallengeRequestSchema = z.object({ publicKey: z.string().trim().min(1).max(130) }).strict();
export const agentVerifyRequestSchema = agentSignatureSchema.extend({ publicKey: z.string().trim().min(1).max(130) }).strict();


const newKey = { publicKey: z.string().trim().min(1).max(130), label: z.string().trim().min(1).max(120) };
export const agentKeyOperationSchema = z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('enroll'), ...newKey }).strict(),
    z.object({ operation: z.literal('recover'), ...newKey }).strict(),
    z.object({ operation: z.literal('rotate'), ...newKey, retireCurrent: z.boolean().optional() }).strict(),
    z.object({ operation: z.literal('revoke'), methodId: z.string().min(1) }).strict(),
]);
export type AgentKeyOperation = z.infer<typeof agentKeyOperationSchema>;
export const agentKeyOperationProofSchema = z.object({
    challenge: z.string().regex(/^[0-9a-f]{64}$/),
    timestamp: z.number().int().positive(),
    keySignature: z.string().regex(/^[0-9a-f]+$/i).max(160).optional(),
    governorSignature: z.string().regex(/^[0-9a-f]+$/i).max(160).optional(),
    reauth: reauthProofSchema.optional(),
}).strict();
export type AgentKeyOperationProof = z.infer<typeof agentKeyOperationProofSchema>;
export const executeAgentKeyOperationSchema = z.object({
    operation: agentKeyOperationSchema,
    proof: agentKeyOperationProofSchema,
}).strict();

export const agentKeyOperationChallengeSchema = z.object({
  claims: agentProofClaimsSchema,
  governorPublicKey: z.string().nullable(),
}).strict();
export const agentKeyOperationResultSchema = z.object({
  methodId: z.string().nullable(),
  revokedMethodIds: z.array(z.string()),
}).strict();
