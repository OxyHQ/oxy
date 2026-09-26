/**
 * A fresh passkey assertion for an operation on a passkey account that needs
 * the person, not only their session — deleting the account (ADR 0029 D3).
 *
 * The options name the account's own passkeys and require user verification;
 * their challenge is a one-use `authentication` row in `webauthn_challenges`
 * bound to the account, spent by the one conditional UPDATE in
 * {@link verifyAccountPasskeyAssertion} before the assertion is checked. The
 * ceremony must come from auth.oxy.so, the one origin that asserts passkeys.
 */
import { and, eq, gt } from 'drizzle-orm';
import { generateAuthenticationOptions, type AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { decodeClientDataJSON } from '@simplewebauthn/server/helpers';
import { IDENTITY_ERROR_CODES, type WebauthnAssertionResponse } from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { getWebauthnRpId } from '../config/env';
import { webauthnChallenges } from '../db/schema/webauthnChallenges';
import { webauthnCredentials } from '../db/schema/webauthnCredentials';
import { ApiError } from '../utils/error';
import { isAuthWebOrigin } from '../utils/origin';
import { verifyFreshPasskeyAssertion } from './webauthnFreshAssertion.service';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function freshFactorRequired(): ApiError {
  return new ApiError(401, 'Confirm with one of this account’s passkeys', IDENTITY_ERROR_CODES.freshFactorRequired);
}

/** WebAuthn request options over the account's passkeys, with a challenge bound to it. */
export async function accountPasskeyAssertionOptions(userId: string): Promise<unknown> {
  const db = getDb();
  const credentials = await db
    .select({ credentialID: webauthnCredentials.credentialID, transports: webauthnCredentials.transports })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId));
  if (credentials.length === 0) {
    throw new ApiError(400, 'This account has no passkey', IDENTITY_ERROR_CODES.freshFactorRequired);
  }
  const options = await generateAuthenticationOptions({
    rpID: getWebauthnRpId(),
    allowCredentials: credentials.map((credential) => ({
      id: credential.credentialID,
      transports: (credential.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
    })),
    userVerification: 'required',
  });
  await db.insert(webauthnChallenges).values({
    challenge: options.challenge,
    type: 'authentication',
    userId,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    used: false,
  });
  return options;
}

/** Spend the challenge the assertion signed, then verify it is one of the account's passkeys. */
export async function verifyAccountPasskeyAssertion(userId: string, assertion: WebauthnAssertionResponse): Promise<void> {
  let challenge: unknown;
  try {
    challenge = (decodeClientDataJSON(assertion.response.clientDataJSON) as { challenge?: unknown }).challenge;
  } catch {
    throw freshFactorRequired();
  }
  if (typeof challenge !== 'string' || challenge.length === 0) throw freshFactorRequired();

  const db = getDb();
  await db.transaction(async (tx) => {
    const burned = await tx
      .update(webauthnChallenges)
      .set({ used: true })
      .where(
        and(
          eq(webauthnChallenges.challenge, challenge),
          eq(webauthnChallenges.type, 'authentication'),
          eq(webauthnChallenges.userId, userId),
          eq(webauthnChallenges.used, false),
          gt(webauthnChallenges.expiresAt, new Date()),
        ),
      )
      .returning({ id: webauthnChallenges.id });
    if (burned.length === 0) throw freshFactorRequired();
    await verifyFreshPasskeyAssertion(tx, {
      userId,
      response: assertion,
      challengeHex: Buffer.from(challenge, 'base64url').toString('hex'),
      allowOrigin: isAuthWebOrigin,
    });
  });
}
