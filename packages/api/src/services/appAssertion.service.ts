/**
 * App assertions (ADR 0045): an Oxy app proves which app it is.
 *
 * The person's own bearer authenticates every call; the app proves itself by
 * platform, and Oxy signs a five-minute `OXY-APP+JWT` naming the application,
 * the person (`sub`) and the session (`sid`) — with the capability-ticket key,
 * published at `/capabilities/.well-known/jwks.json` beside the tickets and the
 * requester assertions it already signs.
 *
 * ## What each platform proves
 *
 * - **web**: the request's `Origin` is one of the application's registered
 *   `webOrigins`. A page cannot set `Origin`; a scripted client that forges it
 *   gets an assertion for its own session only (ADR 0045, Consequences).
 * - **android**: a Play Integrity token Google decodes for the registered
 *   package, whose verdict names that package, a registered signing
 *   certificate, `PLAY_RECOGNIZED`, and the `requestHash` of a challenge minted
 *   here for this person, session and application.
 * - **ios**: an App Attest assertion over such a challenge, signed by a key
 *   attested for the registered team and bundle, its counter moving forward.
 *
 * ## Refusals, in the order they are decided
 *
 * 1. The application is active and declares that platform; the session is not
 *    another application's (a third-party app's own session can assert only
 *    that app).
 * 2. The challenge is burned — before the proof is looked at, so a refused
 *    proof cannot be retried and a used token or assertion cannot be replayed.
 * 3. The proof is verified.
 *
 * Every refusal is an {@link AppAssertionRefusal} carrying a stable code from
 * `APP_ASSERTION_ERROR_CODES`; the reason a proof failed goes to the log only.
 */

import {
  createHash,
  randomBytes,
  randomUUID,
  type KeyObject,
  type X509Certificate,
} from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import {
  OXY_APP_ASSERTION_AUDIENCE,
  OXY_APP_ASSERTION_TTL_SECONDS,
  type AppAssertionChallengePurpose,
  type AppAssertionChallengeRequest,
  type AppAssertionChallengeResponse,
  type AppAssertionErrorCode,
  type AppAssertionRequest,
  type AppAssertionResponse,
  type AppAttestKeyRequest,
  type AppAttestKeyResponse,
  type ApplicationRecognition,
} from '@oxy.so/contracts';
import { signOxyAppAssertion } from '@oxy.so/core/server';
import {
  appAttestAllowedEnvironments,
  appleAppAttestationRootCertificate,
} from '../config/appAttest';
import { capabilityTicketSigningConfig } from '../config/capabilityTicketSigning';
import { playIntegrityConfig } from '../config/playIntegrity';
import { getDb } from '../config/postgres';
import { appAssertionChallenges } from '../db/schema/appAssertionChallenges';
import { appAttestKeys } from '../db/schema/appAttestKeys';
import { applicationWebOrigins } from '../db/schema/applicationRecognition';
import { applications } from '../db/schema/applications';
import { logger } from '../utils/logger';
import { isUniqueViolation } from '@oxy.so/db';
import {
  type AppAttestEnvironment,
  AppAttestVerificationError,
  appAttestAppId,
  appAttestClientDataHash,
  verifyAppAttestAssertion,
  verifyAppAttestAttestation,
} from './appAttest';
import { readApplicationRecognition } from './applicationRecognition.service';
import {
  createPlayIntegrityClient,
  judgePlayIntegrityVerdict,
  type PlayIntegrityClient,
  PlayIntegrityTokenRejectedError,
  type PlayIntegrityVerdict,
} from './playIntegrity.service';

/** How long a device has to spend a challenge. */
export const APP_ASSERTION_CHALLENGE_TTL_SECONDS = 120;

const REFUSAL_STATUS: Record<AppAssertionErrorCode, 400 | 403 | 409 | 503> = {
  application_unavailable: 403,
  session_other_application: 403,
  platform_not_registered: 403,
  origin_not_registered: 403,
  challenge_invalid: 403,
  integrity_refused: 403,
  integrity_unconfigured: 503,
  integrity_unavailable: 503,
  attest_key_unknown: 403,
  attest_key_exists: 409,
  attestation_invalid: 403,
  assertion_invalid: 403,
  signing_unavailable: 503,
};

const REFUSAL_MESSAGE: Record<AppAssertionErrorCode, string> = {
  application_unavailable: 'No active application has that id',
  session_other_application: 'This session belongs to another application',
  platform_not_registered: 'The application declares no recognition for that platform',
  origin_not_registered: 'This origin is not one of the application’s web origins',
  challenge_invalid: 'The challenge is unknown, used, expired or minted for something else',
  integrity_refused: 'The Play Integrity verdict does not recognise this app',
  integrity_unconfigured: 'Play Integrity is not configured',
  integrity_unavailable: 'Play Integrity is unavailable',
  attest_key_unknown: 'No App Attest key with that id is registered for this application',
  attest_key_exists: 'That App Attest key is already registered',
  attestation_invalid: 'The App Attest attestation does not verify',
  assertion_invalid: 'The App Attest assertion does not verify',
  signing_unavailable: 'Oxy cannot sign app assertions right now',
};

export class AppAssertionRefusal extends Error {
  readonly status: 400 | 403 | 409 | 503;

  constructor(readonly code: AppAssertionErrorCode) {
    super(REFUSAL_MESSAGE[code]);
    this.name = 'AppAssertionRefusal';
    this.status = REFUSAL_STATUS[code];
  }
}

/** The verified bearer making the call. */
export interface AppAssertionCaller {
  /** The account the session acts as: the assertion's `sub`. */
  readonly userId: string;
  readonly sessionId: string;
  /** The application the session belongs to; NULL is the shared session every official app uses. */
  readonly sessionApplicationId: string | null;
}

export interface AppAssertionDependencies {
  readonly now: () => Date;
  readonly issuer: string;
  readonly signing: () => { readonly keyId: string; readonly privateKey: KeyObject };
  /** `null` when Play Integrity is not configured. */
  readonly playIntegrity: () => {
    readonly cloudProjectNumber: string;
    readonly client: PlayIntegrityClient;
  } | null;
  readonly appAttestRoot: () => X509Certificate;
  readonly appAttestEnvironments: () => readonly AppAttestEnvironment[];
}

let playIntegrityClient: { config: object; client: PlayIntegrityClient } | undefined;

/** Production wiring. */
export function appAssertionRuntime(): AppAssertionDependencies {
  return {
    now: () => new Date(),
    issuer: process.env.OXY_API_URL ?? 'https://api.oxy.so',
    signing: () => {
      const config = capabilityTicketSigningConfig();
      return { keyId: config.keyId, privateKey: config.privateKey };
    },
    playIntegrity: () => {
      const config = playIntegrityConfig();
      if (!config) return null;
      if (playIntegrityClient?.config !== config) {
        playIntegrityClient = { config, client: createPlayIntegrityClient(config) };
      }
      return { cloudProjectNumber: config.cloudProjectNumber, client: playIntegrityClient.client };
    },
    appAttestRoot: appleAppAttestationRootCertificate,
    appAttestEnvironments: appAttestAllowedEnvironments,
  };
}

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * What the device signs or hands to Play Integrity: the challenge bound to the
 * application, platform, purpose and session it was minted for.
 */
export function appAssertionRequestHash(input: {
  applicationId: string;
  platform: 'android' | 'ios';
  purpose: AppAssertionChallengePurpose;
  sessionId: string;
  challenge: string;
}): string {
  return createHash('sha256')
    .update(
      [
        'oxy-app-assertion/v1',
        input.applicationId,
        input.platform,
        input.purpose,
        input.sessionId,
        input.challenge,
      ].join('\n'),
    )
    .digest('base64url');
}

/** Step 1: the application is active, the session may speak for it, and it declares the platform. */
async function recognitionFor(
  caller: AppAssertionCaller,
  applicationId: string,
  platform: 'web' | 'android' | 'ios',
): Promise<ApplicationRecognition> {
  const [application] = await getDb()
    .select({ status: applications.status })
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(1);
  if (application?.status !== 'active') throw new AppAssertionRefusal('application_unavailable');
  if (caller.sessionApplicationId !== null && caller.sessionApplicationId !== applicationId) {
    throw new AppAssertionRefusal('session_other_application');
  }
  const recognition = await readApplicationRecognition(applicationId);
  const declared =
    platform === 'web'
      ? recognition.webOrigins.length > 0
      : platform === 'android'
        ? recognition.android !== null
        : recognition.ios !== null;
  if (!declared) throw new AppAssertionRefusal('platform_not_registered');
  return recognition;
}

/** `POST /apps/assertions/challenge`. */
export async function mintAppAssertionChallenge(
  caller: AppAssertionCaller,
  request: AppAssertionChallengeRequest,
  deps: AppAssertionDependencies,
): Promise<AppAssertionChallengeResponse> {
  await recognitionFor(caller, request.applicationId, request.platform);
  const purpose = request.platform === 'ios' ? request.purpose : 'assertion';
  let cloudProjectNumber: string | undefined;
  if (request.platform === 'android') {
    const playIntegrity = deps.playIntegrity();
    if (!playIntegrity) throw new AppAssertionRefusal('integrity_unconfigured');
    cloudProjectNumber = playIntegrity.cloudProjectNumber;
  }
  const challenge = randomBytes(32).toString('base64url');
  const expiresAt = new Date(deps.now().getTime() + APP_ASSERTION_CHALLENGE_TTL_SECONDS * 1000);
  await getDb()
    .insert(appAssertionChallenges)
    .values({
      challengeHash: sha256Hex(challenge),
      userId: caller.userId,
      sessionId: caller.sessionId,
      applicationId: request.applicationId,
      platform: request.platform,
      purpose,
      expiresAt,
    });
  return {
    challenge,
    requestHash: appAssertionRequestHash({
      applicationId: request.applicationId,
      platform: request.platform,
      purpose,
      sessionId: caller.sessionId,
      challenge,
    }),
    expiresAt: expiresAt.toISOString(),
    ...(cloudProjectNumber ? { cloudProjectNumber } : {}),
  };
}

/**
 * Step 2: spend the challenge, once. One conditional UPDATE: a challenge for
 * another person, session, application, platform or purpose, or one already
 * used or expired, matches nothing.
 */
async function burnChallenge(
  caller: AppAssertionCaller,
  input: {
    applicationId: string;
    platform: 'android' | 'ios';
    purpose: AppAssertionChallengePurpose;
    challenge: string;
  },
  now: Date,
): Promise<{ requestHash: string; mintedAt: Date; expiresAt: Date }> {
  const [burned] = await getDb()
    .update(appAssertionChallenges)
    .set({ usedAt: now })
    .where(
      and(
        eq(appAssertionChallenges.challengeHash, sha256Hex(input.challenge)),
        eq(appAssertionChallenges.userId, caller.userId),
        eq(appAssertionChallenges.sessionId, caller.sessionId),
        eq(appAssertionChallenges.applicationId, input.applicationId),
        eq(appAssertionChallenges.platform, input.platform),
        eq(appAssertionChallenges.purpose, input.purpose),
        isNull(appAssertionChallenges.usedAt),
        gt(appAssertionChallenges.expiresAt, now),
      ),
    )
    .returning({ expiresAt: appAssertionChallenges.expiresAt });
  if (!burned) throw new AppAssertionRefusal('challenge_invalid');
  return {
    expiresAt: burned.expiresAt,
    mintedAt: new Date(burned.expiresAt.getTime() - APP_ASSERTION_CHALLENGE_TTL_SECONDS * 1000),
    requestHash: appAssertionRequestHash({
      applicationId: input.applicationId,
      platform: input.platform,
      purpose: input.purpose,
      sessionId: caller.sessionId,
      challenge: input.challenge,
    }),
  };
}

/** `POST /apps/attest-keys`: register an App Attest key attested over an `attest_key` challenge. */
export async function registerAppAttestKey(
  caller: AppAssertionCaller,
  request: AppAttestKeyRequest,
  deps: AppAssertionDependencies,
): Promise<AppAttestKeyResponse> {
  const recognition = await recognitionFor(caller, request.applicationId, 'ios');
  const ios = recognition.ios as NonNullable<ApplicationRecognition['ios']>;
  const now = deps.now();
  const { requestHash } = await burnChallenge(
    caller,
    {
      applicationId: request.applicationId,
      platform: 'ios',
      purpose: 'attest_key',
      challenge: request.challenge,
    },
    now,
  );
  let attested: ReturnType<typeof verifyAppAttestAttestation>;
  try {
    attested = verifyAppAttestAttestation({
      attestation: Buffer.from(request.attestation, 'base64'),
      clientDataHash: appAttestClientDataHash(requestHash),
      keyId: request.keyId,
      appId: appAttestAppId(ios.teamId, ios.bundleId),
      rootCertificate: deps.appAttestRoot(),
      allowedEnvironments: deps.appAttestEnvironments(),
      now,
    });
  } catch (error) {
    if (!(error instanceof AppAttestVerificationError)) throw error;
    logger.info('[app-assertion] App Attest attestation refused', {
      applicationId: request.applicationId,
      reason: error.reason,
    });
    throw new AppAssertionRefusal('attestation_invalid');
  }
  try {
    await getDb()
      .insert(appAttestKeys)
      .values({
        keyId: request.keyId,
        applicationId: request.applicationId,
        publicKeySpki: attested.publicKeySpki.toString('base64'),
        signCount: attested.signCount,
        environment: attested.environment,
        lastUsedAt: now,
      });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppAssertionRefusal('attest_key_exists');
    throw error;
  }
  return { keyId: request.keyId };
}

async function proveAndroid(
  caller: AppAssertionCaller,
  request: Extract<AppAssertionRequest, { platform: 'android' }>,
  recognition: ApplicationRecognition,
  deps: AppAssertionDependencies,
): Promise<void> {
  const android = recognition.android as NonNullable<ApplicationRecognition['android']>;
  const playIntegrity = deps.playIntegrity();
  if (!playIntegrity) throw new AppAssertionRefusal('integrity_unconfigured');
  const challenge = await burnChallenge(
    caller,
    {
      applicationId: request.applicationId,
      platform: 'android',
      purpose: 'assertion',
      challenge: request.proof.challenge,
    },
    deps.now(),
  );
  let verdict: PlayIntegrityVerdict;
  try {
    verdict = await playIntegrity.client.decode(android.packageName, request.proof.integrityToken);
  } catch (error) {
    if (error instanceof PlayIntegrityTokenRejectedError) {
      logger.info('[app-assertion] Play Integrity refused the token', {
        applicationId: request.applicationId,
      });
      throw new AppAssertionRefusal('integrity_refused');
    }
    logger.warn('[app-assertion] Play Integrity unavailable', {
      applicationId: request.applicationId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new AppAssertionRefusal('integrity_unavailable');
  }
  const failure = judgePlayIntegrityVerdict(verdict, {
    packageName: android.packageName,
    signingCertSha256: android.signingCertSha256,
    requestHash: challenge.requestHash,
    notBefore: challenge.mintedAt,
    notAfter: challenge.expiresAt,
  });
  if (failure) {
    logger.info('[app-assertion] Play Integrity verdict refused', {
      applicationId: request.applicationId,
      reason: failure,
    });
    throw new AppAssertionRefusal('integrity_refused');
  }
}

async function proveIos(
  caller: AppAssertionCaller,
  request: Extract<AppAssertionRequest, { platform: 'ios' }>,
  recognition: ApplicationRecognition,
  deps: AppAssertionDependencies,
): Promise<void> {
  const ios = recognition.ios as NonNullable<ApplicationRecognition['ios']>;
  const now = deps.now();
  const { requestHash } = await burnChallenge(
    caller,
    {
      applicationId: request.applicationId,
      platform: 'ios',
      purpose: 'assertion',
      challenge: request.proof.challenge,
    },
    now,
  );
  const db = getDb();
  const [key] = await db
    .select({ publicKeySpki: appAttestKeys.publicKeySpki, signCount: appAttestKeys.signCount })
    .from(appAttestKeys)
    .where(
      and(
        eq(appAttestKeys.keyId, request.proof.keyId),
        eq(appAttestKeys.applicationId, request.applicationId),
      ),
    )
    .limit(1);
  if (!key) throw new AppAssertionRefusal('attest_key_unknown');
  let signCount: number;
  try {
    ({ signCount } = verifyAppAttestAssertion({
      assertion: Buffer.from(request.proof.assertion, 'base64'),
      clientDataHash: appAttestClientDataHash(requestHash),
      publicKeySpki: Buffer.from(key.publicKeySpki, 'base64'),
      appId: appAttestAppId(ios.teamId, ios.bundleId),
      previousSignCount: key.signCount,
    }));
  } catch (error) {
    if (!(error instanceof AppAttestVerificationError)) throw error;
    logger.info('[app-assertion] App Attest assertion refused', {
      applicationId: request.applicationId,
      reason: error.reason,
    });
    throw new AppAssertionRefusal('assertion_invalid');
  }
  // The counter moves forward exactly once: of two assertions racing with
  // the same counter, one updates the row and the other matches nothing.
  const [advanced] = await db
    .update(appAttestKeys)
    .set({ signCount, lastUsedAt: now })
    .where(
      and(
        eq(appAttestKeys.keyId, request.proof.keyId),
        sql`${appAttestKeys.signCount} < ${signCount}`,
      ),
    )
    .returning({ keyId: appAttestKeys.keyId });
  if (!advanced) throw new AppAssertionRefusal('assertion_invalid');
}

/**
 * `POST /apps/assertions`. `origin` is the request's `Origin` header, read only
 * for a web proof.
 */
export async function issueAppAssertion(
  caller: AppAssertionCaller,
  request: AppAssertionRequest,
  origin: string | undefined,
  deps: AppAssertionDependencies,
): Promise<AppAssertionResponse> {
  const recognition = await recognitionFor(caller, request.applicationId, request.platform);
  if (request.platform === 'web') {
    const [registered] = origin
      ? await getDb()
          .select({ origin: applicationWebOrigins.origin })
          .from(applicationWebOrigins)
          .where(
            and(
              eq(applicationWebOrigins.origin, origin),
              eq(applicationWebOrigins.applicationId, request.applicationId),
            ),
          )
          .limit(1)
      : [];
    if (!registered) throw new AppAssertionRefusal('origin_not_registered');
  } else if (request.platform === 'android') {
    await proveAndroid(caller, request, recognition, deps);
  } else {
    await proveIos(caller, request, recognition, deps);
  }

  let signing: ReturnType<AppAssertionDependencies['signing']>;
  try {
    signing = deps.signing();
  } catch {
    throw new AppAssertionRefusal('signing_unavailable');
  }
  const issuedAt = Math.floor(deps.now().getTime() / 1000);
  const expiresAt = issuedAt + OXY_APP_ASSERTION_TTL_SECONDS;
  const assertion = signOxyAppAssertion(
    {
      iss: deps.issuer,
      aud: OXY_APP_ASSERTION_AUDIENCE,
      sub: caller.userId,
      sid: caller.sessionId,
      app: request.applicationId,
      platform: request.platform,
      iat: issuedAt,
      exp: expiresAt,
      jti: randomUUID(),
    },
    signing,
  );
  return {
    assertion,
    applicationId: request.applicationId,
    platform: request.platform,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}
