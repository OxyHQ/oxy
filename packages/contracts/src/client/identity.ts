/**
 * The signed-record envelope check, without Zod. Schemas: `../identity.ts`.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

import type { SignedRecordEnvelope } from '../identity';
import {
  exact,
  int,
  literal,
  minLength,
  nonnegative,
  nullable,
  number,
  object,
  optional,
  refineAt,
  string,
  union,
  unknownRecord,
} from './check';

const CHAIN_FIELDS = ['seq', 'prev', 'collection', 'rkey'] as const;

/** The twin of `signedRecordEnvelopeSchema`: v2 requires the chain fields, v1 forbids them. */
export const signedRecordEnvelopeCheck = exact<SignedRecordEnvelope>()(
  refineAt(
    object({
      version: union(literal(1), literal(2)),
      type: string(minLength(1)),
      subject: string(),
      issuer: string(),
      record: unknownRecord,
      issuedAt: number(),
      seq: optional(number(int, nonnegative)),
      prev: optional(nullable(string())),
      collection: optional(string(minLength(1))),
      rkey: optional(string(minLength(1))),
      publicKey: string(),
      alg: literal('ES256K-DER-SHA256'),
      signature: string(),
    }),
    (env) => {
      if (env.version === 2) {
        if (typeof env.seq !== 'number')
          return { path: ['seq'], message: 'v2 envelope requires `seq`' };
        if (env.prev === undefined) {
          return { path: ['prev'], message: 'v2 envelope requires `prev` (use `null` at genesis)' };
        }
        if (typeof env.collection !== 'string') {
          return { path: ['collection'], message: 'v2 envelope requires `collection`' };
        }
        if (typeof env.rkey !== 'string') {
          return { path: ['rkey'], message: 'v2 envelope requires `rkey`' };
        }
        return undefined;
      }
      const carried = CHAIN_FIELDS.find((field) => env[field] !== undefined);
      return carried
        ? { path: [carried], message: `v1 envelope must not carry \`${carried}\`` }
        : undefined;
    },
  ),
);
