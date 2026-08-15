/**
 * The `oxy_sk_…` machine credential lane (issue #972 §2.3).
 *
 * One bearer string, sent by a stock OpenAI SDK as `Authorization: Bearer …`,
 * resolved to the application principal every inference request must attribute
 * to: `applicationId`, `credentialId`, `ownerAccountId`, `environment` and the
 * effective scopes.
 *
 * ## NOTHING MOUNTS THIS YET, AND THAT IS THE DECISION
 *
 * No route in this package uses {@link requireMachineCredential}. That is
 * deliberate and it is not an oversight to be tidied away by wiring it to the
 * nearest plausible endpoint.
 *
 * The nearest plausible endpoint is `POST /v1/chat/completions`
 * (`routes/alia.ts`), and mounting it there was wrong for a reason a rate limit
 * cannot fix: that route forwards the caller's body verbatim to Alia on ONE
 * static `ALIA_API_KEY`, and `max_tokens` is the caller's to choose — so a cap
 * of N requests per window bounds requests, never cost. Worse, the cost lands on
 * a single shared Oxy budget with no per-account attribution, so one key cannot
 * be stopped without stopping all of them. The epic's own invariant is "reserve
 * spend before the request enters the data plane", and nothing in the platform
 * reserves, meters or charges anything yet — `api_key_usage_events` has no
 * writer and `deductCredits` has no production caller (audit, #976).
 *
 * **Workstream 4 mounts this**, on the real public inference edge, behind the
 * reservation workstream 7 is building. Until both exist, an `oxy_sk_…`
 * credential can be minted, rotated, revoked and audited — and authenticates
 * nowhere. That is the intended state, not a gap.
 *
 * ## Its own lane, and its own request property
 *
 * This does NOT set `req.serviceApp`, and that is the security-relevant choice
 * in the whole module. A service token's gate is that only a platform-TRUSTED
 * application may hold a `service` credential at all (plus the narrow Oxy Pay
 * carve-out); everything mounted behind `serviceAuthMiddleware` — federation,
 * accounts provisioning, chains, notifications, signals — is written against
 * that. A machine credential is by design self-serve for external developers,
 * so populating `req.serviceApp` from one would hand every third-party app the
 * lane that gate exists to protect. `req.machineCredential` is a distinct
 * principal a route has to opt into by name.
 *
 * ## Order of checks, and what each refusal may reveal
 *
 * The token's hash is verified BEFORE status, environment and application state.
 * A caller who does not hold the secret therefore learns nothing about a real
 * credential's lifecycle from which refusal they get — every failed secret is
 * the same answer. Every refusal is also the same HTTP status and the same
 * message; the reason is recorded in the audit trail, never returned.
 *
 * ## `oxy_dk_…` is refused here, structurally
 *
 * The lane only ever matches `token_prefix`, a column no OAuth client id is ever
 * written to, and the parse refuses anything not shaped like a machine token. A
 * bare public identifier presented as a bearer cannot resolve — it is not a
 * check that could be forgotten, it is a column it is not in.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { verifySecret } from '@oxyhq/core/server';
import { getDb } from '../config/postgres';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import type { ApplicationCredentialEnvironment } from '../db/schema/applicationCredentials';
import { applications } from '../db/schema/applications';
import type { CredentialValidationFailureReason } from '../db/schema/applicationCredentialAuditEvents';
import { recordCredentialValidationFailure } from '../services/applicationCredentialAudit.service';
import { intersectScopes, type ApplicationScope } from '../utils/applicationScopes';
import { isCredentialUsable } from '../utils/credentialUsability';
import { deploymentCredentialEnvironment } from '../utils/credentialEnvironment';
import { extractTokenFromRequest } from './authUtils';
import { logger } from '../utils/logger';
import {
  hashMachineCredentialToken,
  machineCredentialTokenPrefix,
} from '../utils/machineCredentialToken';
import { rateLimit } from './rateLimiter';

/**
 * Requests per minute one machine CREDENTIAL may make.
 *
 * Deliberately modest. Until the usage ledger lands (§7) an accepted request
 * spends a shared upstream budget with no per-request accounting behind it, so
 * this number is the only thing bounding what one leaked or runaway key can
 * cost. Raising it is a decision to make once spend is metered, not before.
 */
export const MACHINE_CREDENTIAL_REQUESTS_PER_MINUTE = 60;

/**
 * Requests per minute one APPLICATION may make across all of its machine
 * credentials.
 *
 * Higher than the per-credential ceiling on purpose: an application legitimately
 * runs several keys (per environment, per service), and this bounds the sum
 * without making a second key useless. It is the limit that survives an
 * application minting keys in a loop, which the per-credential one cannot see.
 */
export const MACHINE_APPLICATION_REQUESTS_PER_MINUTE = 300;

/** Window both machine limiters measure over. */
const MACHINE_LIMIT_WINDOW_MS = 60_000;

/**
 * How stale `last_used_at` may get before the lane refreshes it.
 *
 * The column answers "is this key still in use", to the minute at best — and
 * writing it on every request would put an UPDATE on the hot path of an
 * inference edge for a value nothing reads at that resolution.
 */
const LAST_USED_REFRESH_MS = 60_000;

/** What a verified machine bearer resolves to. */
export interface MachineCredentialPrincipal {
  credentialId: string;
  applicationId: string;
  applicationName: string;
  /** The Oxy account financially responsible for this workload. */
  ownerAccountId: string;
  environment: ApplicationCredentialEnvironment;
  /** Credential scopes ∩ application scopes — never the credential's alone. */
  scopes: ApplicationScope[];
}

/** A request the machine lane has authenticated. */
export interface MachineCredentialRequest extends Request {
  machineCredential?: MachineCredentialPrincipal;
}

/**
 * Why a bearer did not resolve.
 *
 * `not_machine_token` is separate from every other value because it is the only
 * one that is not a refusal: it means "some other lane should look at this".
 */
export type MachineCredentialResolution =
  | { ok: true; principal: MachineCredentialPrincipal }
  | { ok: false; reason: 'not_machine_token' | 'unknown_credential' }
  | { ok: false; reason: CredentialValidationFailureReason };

/** The credential columns this lane reads. `token_prefix` is never returned. */
const LANE_COLUMNS = {
  id: applicationCredentials.id,
  applicationId: applicationCredentials.applicationId,
  type: applicationCredentials.type,
  environment: applicationCredentials.environment,
  scopes: applicationCredentials.scopes,
  status: applicationCredentials.status,
  expiresAt: applicationCredentials.expiresAt,
  lastUsedAt: applicationCredentials.lastUsedAt,
  tokenHash: applicationCredentials.tokenHash,
};

/**
 * Refresh `last_used_at` when it has gone stale, without blocking the request.
 *
 * Detached on purpose — the caller's response does not depend on it — but the
 * rejection is handled, so a failed write is a log line rather than an
 * unhandled rejection that takes the process down.
 */
function touchLastUsed(credentialId: string, lastUsedAt: Date | null): void {
  if (lastUsedAt && Date.now() - lastUsedAt.getTime() < LAST_USED_REFRESH_MS) {
    return;
  }
  void getDb()
    .update(applicationCredentials)
    .set({ lastUsedAt: new Date() })
    .where(eq(applicationCredentials.id, credentialId))
    .catch((error: unknown) => {
      logger.error(
        'Failed to refresh machine credential last_used_at',
        error instanceof Error ? error : new Error(String(error)),
        { component: 'machineCredential', credentialId }
      );
    });
}

/**
 * Resolve a bearer string to a machine principal.
 *
 * Every refusal after the credential is found is audited, with the reason — that
 * is the §2.3 "audit events for failed validation" requirement, and it is here
 * rather than in the middleware so the service-token-style callers a future
 * inference edge adds cannot get the principal without the trail.
 */
export async function resolveMachineCredential(
  token: string
): Promise<MachineCredentialResolution> {
  const tokenPrefix = machineCredentialTokenPrefix(token);
  if (!tokenPrefix) {
    // Either a bearer of another kind, or a malformed machine token — one
    // answer for both, deliberately. Distinguishing them would hand a caller a
    // way to ask whether a string looks like an Oxy API key, and nothing
    // downstream of a resolution needs to know which it was.
    return { ok: false, reason: 'not_machine_token' };
  }

  const [credential] = await getDb()
    .select(LANE_COLUMNS)
    .from(applicationCredentials)
    .where(
      and(
        eq(applicationCredentials.tokenPrefix, tokenPrefix),
        eq(applicationCredentials.type, 'machine')
      )
    )
    .limit(1);

  // No row, or — impossible under the table's own CHECK, asserted anyway — a
  // machine row with no hash. Nothing to attribute an audit event to.
  if (!credential || !credential.tokenHash) {
    return { ok: false, reason: 'unknown_credential' };
  }

  const failure = async (
    reason: CredentialValidationFailureReason,
    metadata?: Record<string, unknown>
  ): Promise<MachineCredentialResolution> => {
    await recordCredentialValidationFailure({
      applicationId: credential.applicationId,
      credentialId: credential.id,
      reason,
      environment: credential.environment,
      metadata,
    });
    return { ok: false, reason };
  };

  // Constant-time, and FIRST: no later refusal may be reachable without the
  // secret, or the distinct reasons become an oracle on a credential's state.
  if (!verifySecret(hashMachineCredentialToken(token), credential.tokenHash)) {
    return failure('secret_mismatch');
  }

  // `active`, or `deprecated` inside a rotation grace. The shared predicate —
  // never a second copy of the rule.
  if (!isCredentialUsable(credential)) {
    return failure('not_usable', { status: credential.status });
  }

  const deployment = deploymentCredentialEnvironment();
  if (credential.environment !== deployment) {
    return failure('environment_mismatch', { expected: deployment });
  }

  const [application] = await getDb()
    .select({
      id: applications.id,
      name: applications.name,
      status: applications.status,
      scopes: applications.scopes,
      ownerAccountId: applications.ownerAccountId,
    })
    .from(applications)
    .where(eq(applications.id, credential.applicationId))
    .limit(1);

  if (!application || application.status !== 'active') {
    return failure('application_inactive', { status: application?.status ?? 'missing' });
  }

  touchLastUsed(credential.id, credential.lastUsedAt);

  return {
    ok: true,
    principal: {
      credentialId: credential.id,
      applicationId: application.id,
      applicationName: application.name,
      ownerAccountId: application.ownerAccountId,
      environment: credential.environment,
      // Credential ∩ application, with NO empty-means-everything fallback. The
      // service-token mint has one for credentials provisioned before scopes
      // existed; a machine credential is required to name at least one scope at
      // creation, so there is no legacy shape to accommodate and inheriting an
      // application's full grant by default would be the wrong default for an
      // external API key.
      scopes: intersectScopes(credential.scopes, application.scopes),
    },
  };
}

/** The one refusal body this lane ever emits. */
function refuse(res: Response): void {
  res.status(401).json({
    error: 'Invalid credentials',
    message: 'The provided API key is invalid, expired, or revoked.',
  });
}

/**
 * Authenticate an `oxy_sk_…` bearer and require `scope`.
 *
 * A route mounting this accepts ONLY machine credentials — see the module
 * header for why no route mounts it yet, and which workstream will.
 */
export function requireMachineCredential(scope: ApplicationScope): RequestHandler {
  return async (req: MachineCredentialRequest, res: Response, next: NextFunction) => {
    const token = extractTokenFromRequest(req);
    if (!token) {
      return refuse(res);
    }

    const resolution = await resolveMachineCredential(token);
    if (!resolution.ok) {
      return refuse(res);
    }

    if (!resolution.principal.scopes.includes(scope)) {
      await recordCredentialValidationFailure({
        applicationId: resolution.principal.applicationId,
        credentialId: resolution.principal.credentialId,
        reason: 'scope_missing',
        environment: resolution.principal.environment,
        metadata: { requiredScope: scope },
      });
      return res.status(403).json({
        error: 'Forbidden',
        message: `This API key does not hold the required scope ${scope}.`,
      });
    }

    req.machineCredential = resolution.principal;
    next();
  };
}

/** True once the machine lane has authenticated this request. */
function hasMachinePrincipal(req: Request): boolean {
  return Boolean((req as MachineCredentialRequest).machineCredential);
}

/**
 * Per-credential request budget. Belongs AFTER {@link requireMachineCredential}
 * in a chain, because its key does not exist before it.
 *
 * `skip` is the negation of "the key exists", never a policy: a request the lane
 * did not authenticate has no `credentialId`, and without the skip every such
 * request would bucket under one empty key and exhaust the budget for every real
 * key at once. It is not a substitute for a spend reservation and never was —
 * see the module header.
 */
export const machineCredentialLimiter = rateLimit({
  prefix: 'rl:machine:credential:',
  windowMs: MACHINE_LIMIT_WINDOW_MS,
  max: MACHINE_CREDENTIAL_REQUESTS_PER_MINUTE,
  keyGenerator: (req) => (req as MachineCredentialRequest).machineCredential?.credentialId ?? '',
  skip: (req) => !hasMachinePrincipal(req),
  message: 'API key request limit exceeded, please slow down.',
});

/** Per-application request budget across every machine credential it holds. */
export const machineApplicationLimiter = rateLimit({
  prefix: 'rl:machine:application:',
  windowMs: MACHINE_LIMIT_WINDOW_MS,
  max: MACHINE_APPLICATION_REQUESTS_PER_MINUTE,
  keyGenerator: (req) => (req as MachineCredentialRequest).machineCredential?.applicationId ?? '',
  skip: (req) => !hasMachinePrincipal(req),
  message: 'Application request limit exceeded, please slow down.',
});
