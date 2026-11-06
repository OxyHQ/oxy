/**
 * A platform's own sign-in (ADR 0058 2.1): the `platformClient` a password or
 * second-factor sign-in may carry, and the registry facts that make it one.
 *
 * `{ platform, clientId }` is honoured only when:
 *
 * - the request carries NO browser context (`Origin` or `Sec-Fetch-Site`): a
 *   platform credential is never issued to a web page;
 * - `clientId` is a usable public client id of an ACTIVE, TRUSTED (first-party)
 *   application;
 * - that application's registry entry declares `platformHost` equal to
 *   `platform` (written only by staff, or the canonical seed).
 *
 * Anything else is refused with the ordinary invalid-request answer — the same
 * 400 `validate` gives a body that is not the contract's — and it is decided
 * BEFORE the sign-in looks an account up or hashes a password. It depends only
 * on the request and the registry, never on what the person typed, so it
 * cannot say whether an account exists: a known and an unknown identifier get
 * the same answer and the same work, and neither counts toward a lockout.
 */

import type { Request } from 'express';
import type { PlatformClient } from '@oxy.so/contracts';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import { applicationRecognition } from '../db/schema/applicationRecognition';
import { applications } from '../db/schema/applications';
import { isCredentialUsable } from '../utils/credentialUsability';
import { BadRequestError } from '../utils/error';
import { isBrowserClient } from '../utils/origin';
import { isTrustedApplication } from '../utils/trustedApplication';

/** A platform client the registry vouches for. */
export interface ResolvedPlatformClient {
  platform: 'oxyos' | 'astro';
  /** The public client id the sign-in named. */
  clientId: string;
  /** The platform's own application. */
  applicationId: string;
}

/** The answer `validate` gives a body that is not the contract's, for `platformClient`. */
function invalidPlatformClient(): BadRequestError {
  return new BadRequestError('Validation failed', {
    issues: [{ path: 'platformClient', message: 'Invalid platform client', code: 'custom' }],
  });
}

/**
 * The platform client a sign-in names, resolved against the registry; `null`
 * when it names none. Throws the invalid-request answer when it names one that
 * is not honoured (see the module docblock).
 */
export async function resolvePlatformClient(
  req: Request,
  platformClient: PlatformClient | undefined,
): Promise<ResolvedPlatformClient | null> {
  if (!platformClient) return null;
  if (isBrowserClient(req.headers)) throw invalidPlatformClient();
  const [row] = await getDb()
    .select({
      applicationId: applications.id,
      applicationStatus: applications.status,
      type: applications.type,
      isOfficial: applications.isOfficial,
      isInternal: applications.isInternal,
      status: applicationCredentials.status,
      expiresAt: applicationCredentials.expiresAt,
      platformHost: applicationRecognition.platformHost,
    })
    .from(applicationCredentials)
    .innerJoin(applications, eq(applications.id, applicationCredentials.applicationId))
    .innerJoin(
      applicationRecognition,
      eq(applicationRecognition.applicationId, applicationCredentials.applicationId),
    )
    .where(
      and(
        eq(applicationCredentials.publicKey, platformClient.clientId),
        eq(applicationCredentials.type, 'public'),
      ),
    )
    .limit(1);
  if (
    !row ||
    row.applicationStatus !== 'active' ||
    !isCredentialUsable(row) ||
    !isTrustedApplication(row) ||
    row.platformHost !== platformClient.platform
  ) {
    throw invalidPlatformClient();
  }
  return {
    platform: platformClient.platform,
    clientId: platformClient.clientId,
    applicationId: row.applicationId,
  };
}
