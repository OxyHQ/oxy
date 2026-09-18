/**
 * A fresh use of an account's EXISTING passkey, bound to one root-proof challenge.
 *
 * ADR 0024 D8: a keyless account's first root is linked only when the person
 * proves, right now, the factor the account already has. A bearer — however
 * recent — is a session, not that proof. The holder signs the SAME challenge
 * with its WebAuthn ceremony (`clientDataJSON.challenge` = base64url of the
 * 32 challenge bytes) as the new root signs in its proof, so the two cannot be
 * collected separately and combined.
 *
 * The challenge itself is burned by the root proof that accompanies this
 * assertion (`identityProof.service.ts`), in the same transaction.
 */

import { and, eq } from 'drizzle-orm';
import { verifyAuthenticationResponse, type AuthenticationResponseJSON, type AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { decodeClientDataJSON } from '@simplewebauthn/server/helpers';
import { IDENTITY_ERROR_CODES } from '@oxy.so/contracts';
import type { DatabaseOrTransaction } from '../config/postgres';
import { getWebauthnRpId } from '../config/env';
import { webauthnCredentials } from '../db/schema/webauthnCredentials';
import { ApiError } from '../utils/error';
import { logger } from '../utils/logger';

function freshFactorRequired(message = 'Confirm with one of this account’s passkeys'): ApiError {
  return new ApiError(401, message, IDENTITY_ERROR_CODES.freshFactorRequired);
}

/**
 * Verify `response` as an assertion by one of `userId`'s passkeys over
 * `challengeHex`, from an origin `allowOrigin` accepts. Refreshes the credential's
 * counter. Returns the credential id.
 */
export async function verifyFreshPasskeyAssertion(
  db: DatabaseOrTransaction,
  input: {
    userId: string;
    response: unknown;
    challengeHex: string;
    allowOrigin: (origin: string) => boolean;
  },
): Promise<{ credentialId: string }> {
  const response = input.response as AuthenticationResponseJSON;
  if (!response || typeof response.id !== 'string' || typeof response.response?.clientDataJSON !== 'string') {
    throw freshFactorRequired();
  }

  let clientData: { origin?: unknown; challenge?: unknown; type?: unknown };
  try {
    clientData = decodeClientDataJSON(response.response.clientDataJSON);
  } catch {
    throw freshFactorRequired();
  }
  const expectedChallenge = Buffer.from(input.challengeHex, 'hex').toString('base64url');
  if (
    typeof clientData.origin !== 'string' ||
    clientData.challenge !== expectedChallenge ||
    clientData.type !== 'webauthn.get' ||
    !input.allowOrigin(clientData.origin)
  ) {
    throw freshFactorRequired();
  }

  const [credential] = await db
    .select({
      id: webauthnCredentials.id,
      credentialID: webauthnCredentials.credentialID,
      credentialPublicKey: webauthnCredentials.credentialPublicKey,
      counter: webauthnCredentials.counter,
      transports: webauthnCredentials.transports,
    })
    .from(webauthnCredentials)
    .where(and(eq(webauthnCredentials.credentialID, response.id), eq(webauthnCredentials.userId, input.userId)))
    .limit(1);
  if (!credential) throw freshFactorRequired();

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: clientData.origin,
      expectedRPID: getWebauthnRpId(),
      // Root establishment unwraps under PRF, which the holder always runs with
      // user verification; a presence-only assertion is not that person.
      requireUserVerification: true,
      credential: {
        id: credential.credentialID,
        publicKey: new Uint8Array(credential.credentialPublicKey),
        counter: credential.counter,
        transports: (credential.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
      },
    });
  } catch (error) {
    logger.warn('fresh passkey assertion did not verify', {
      component: 'webauthnFreshAssertion',
      error: error instanceof Error ? error.message : String(error),
    });
    throw freshFactorRequired();
  }
  if (!verification.verified) throw freshFactorRequired();

  const { newCounter } = verification.authenticationInfo;
  if (newCounter !== 0 && newCounter <= credential.counter) throw freshFactorRequired('Passkey authentication rejected');
  await db
    .update(webauthnCredentials)
    .set({ counter: newCounter, lastUsedAt: new Date(), userVerified: verification.authenticationInfo.userVerified })
    .where(eq(webauthnCredentials.id, credential.id));

  return { credentialId: credential.credentialID };
}
