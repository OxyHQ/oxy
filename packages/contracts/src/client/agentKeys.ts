/**
 * Agent-key constants and checks, without Zod. Schemas: `../agentKeys.ts`.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

import type {
  AgentChallengeRequest,
  AgentKeyListResponse,
  AgentKeyOperation,
  AgentKeyOperationChallenge,
  AgentKeyOperationResult,
  AgentProofClaims,
  AgentVerifyRequest,
  ExecuteAgentKeyOperation,
} from '../agentKeys';
import {
  array,
  boolean,
  datetime,
  discriminatedUnion,
  exact,
  int,
  literal,
  maxLength,
  minLength,
  nullable,
  number,
  oneOf,
  optional,
  pattern,
  positive,
  strictObject,
  string,
  trim,
} from './check';
import { reauthProofCheck } from './signIn';

export const AGENT_PROOF_AUDIENCE = 'oxy-api/agent' as const;

export const AGENT_PROOF_TTL_MS = 60_000;

export const AGENT_PROOF_ACTIONS = [
  'agent_signin',
  'agent_enroll',
  'agent_rotate',
  'agent_recover',
  'agent_governance',
] as const;

export type AgentProofAction = (typeof AGENT_PROOF_ACTIONS)[number];

export const ACCOUNT_AUTH_METHODS = ['identity', 'agent_key'] as const;

export type AccountAuthMethod = (typeof ACCOUNT_AUTH_METHODS)[number];

/* -------------------------------------------------------------------------- */
/*  Checks                                                                    */
/* -------------------------------------------------------------------------- */

const hex64 = string(pattern(/^[0-9a-f]{64}$/));
const hexSignature = string(pattern(/^[0-9a-f]+$/i), maxLength(160));
const timestamp = number(int, positive);
const publicKey = string(trim, minLength(1), maxLength(130));
const label = string(trim, minLength(1), maxLength(120));

export const agentProofClaimsCheck = exact<AgentProofClaims>()(
  strictObject({
    version: literal(1),
    audience: literal(AGENT_PROOF_AUDIENCE),
    action: oneOf(AGENT_PROOF_ACTIONS),
    accountId: string(minLength(1)),
    actorId: string(minLength(1)),
    authMethodId: nullable(string()),
    publicKey: string(minLength(1)),
    payloadDigest: hex64,
    challenge: hex64,
    expiresAt: number(int, positive),
  }),
);

export const agentChallengeRequestCheck = exact<AgentChallengeRequest>()(
  strictObject({ publicKey }),
);

export const agentVerifyRequestCheck = exact<AgentVerifyRequest>()(
  strictObject({ challenge: hex64, signature: hexSignature, timestamp, publicKey }),
);

export const agentKeyOperationCheck = exact<AgentKeyOperation>()(
  discriminatedUnion('operation', {
    enroll: strictObject({ operation: literal('enroll'), publicKey, label }),
    recover: strictObject({ operation: literal('recover'), publicKey, label }),
    rotate: strictObject({
      operation: literal('rotate'),
      publicKey,
      label,
      retireCurrent: optional(boolean),
    }),
    revoke: strictObject({ operation: literal('revoke'), methodId: string(minLength(1)) }),
  }),
);

export const executeAgentKeyOperationCheck = exact<ExecuteAgentKeyOperation>()(
  strictObject({
    operation: agentKeyOperationCheck,
    proof: strictObject({
      challenge: hex64,
      timestamp,
      keySignature: optional(hexSignature),
      governorSignature: optional(hexSignature),
      reauth: optional(reauthProofCheck),
    }),
  }),
);

export const agentKeyOperationChallengeCheck = exact<AgentKeyOperationChallenge>()(
  strictObject({ claims: agentProofClaimsCheck, governorPublicKey: nullable(string()) }),
);

export const agentKeyOperationResultCheck = exact<AgentKeyOperationResult>()(
  strictObject({ methodId: nullable(string()), revokedMethodIds: array(string()) }),
);

export const agentKeyListResponseCheck = exact<AgentKeyListResponse>()(
  strictObject({
    keys: array(
      strictObject({
        id: string(),
        publicKey: string(),
        label: string(),
        enrolledByUserId: nullable(string()),
        enrollmentMethod: oneOf(['governor', 'rotation', 'recovery']),
        linkedAt: string(datetime),
        lastUsedAt: nullable(string(datetime)),
        revokedAt: nullable(string(datetime)),
      }),
    ),
  }),
);
