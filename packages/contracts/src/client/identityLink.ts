/**
 * Identity-link constants, QR payload and response checks, without Zod. Schemas: `../identityLink.ts`.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

import type { IdentityLinkCreateResponse, IdentityLinkState } from '../identityLink';
import {
  exact,
  int,
  minLength,
  nullable,
  number,
  object,
  oneOf,
  pattern,
  positive,
  startsWith,
  string,
  trim,
} from './check';

export const IDENTITY_LINK_STATUSES = ['pending', 'signed', 'completed', 'cancelled'] as const;

export type IdentityLinkStatus = (typeof IDENTITY_LINK_STATUSES)[number];

/** The scheme and host Commons routes a link QR to. */
export const IDENTITY_LINK_QR_PREFIX = 'oxycommons://link';

export const LINK_ID = /^[0-9a-f]{32}$/;

export const CHALLENGE = /^[0-9a-f]{64}$/;

/** The QR auth.oxy.so shows: the request's id and the challenge Commons signs. */
export function buildIdentityLinkQrPayload(linkId: string, challenge: string): string {
  return `${IDENTITY_LINK_QR_PREFIX}?id=${linkId}&c=${challenge}`;
}

/** The request a scanned code names, or `null` for anything that is not a link QR. */
export function parseIdentityLinkQrPayload(
  raw: string,
): { linkId: string; challenge: string } | null {
  const value = raw.trim();
  if (!value.startsWith(`${IDENTITY_LINK_QR_PREFIX}?`)) return null;
  // Parsed by hand: React Native's `URLSearchParams` does not implement `get`.
  const params = new Map<string, string>();
  for (const pair of value.slice(IDENTITY_LINK_QR_PREFIX.length + 1).split('&')) {
    const separator = pair.indexOf('=');
    if (separator > 0) params.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  const linkId = params.get('id') ?? '';
  const challenge = params.get('c') ?? '';
  if (!LINK_ID.test(linkId) || !CHALLENGE.test(challenge)) return null;
  return { linkId, challenge };
}

/* -------------------------------------------------------------------------- */
/*  Checks                                                                    */
/* -------------------------------------------------------------------------- */

export const identityLinkCreateResponseCheck = exact<IdentityLinkCreateResponse>()(
  object({
    linkId: string(trim, pattern(LINK_ID, 'linkId must be 32 lowercase hex characters')),
    challenge: string(pattern(CHALLENGE)),
    expiresAt: number(int, positive),
    qrPayload: string(startsWith(IDENTITY_LINK_QR_PREFIX)),
  }),
);

export const identityLinkStateCheck = exact<IdentityLinkState>()(
  object({
    status: oneOf(IDENTITY_LINK_STATUSES),
    userId: string(minLength(1)),
    username: nullable(string()),
    publicKey: nullable(string()),
    audience: string(minLength(1)),
    expiresAt: number(int, positive),
  }),
);
