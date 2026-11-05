/**
 * GitHub trusted publishing (ADR 0057): a GitHub Actions job publishes an
 * application's OTA updates with the OIDC token GitHub issued it, and no
 * stored secret.
 *
 * Three things live here, and nothing else grants on a trusted publisher:
 *
 *   - {@link exchangeGithubActionsToken}: the mint behind
 *     `POST /auth/service-token/github-actions`. A verified GitHub token that
 *     matches one of the application's `github_trusted_publishers` rows becomes
 *     a service token from the SAME `mintServiceToken` the credential path uses,
 *     with the same claim set: `authority: 'external'`, exactly
 *     `['updates:publish']`, and `credentialId: tp_<row id>`.
 *   - {@link resolveLiveTrustedPublisherPrincipal}: the live re-read every
 *     request with such a token goes through (routed here by the `tp_` prefix
 *     from `resolveLiveExternalServicePrincipal`). Deleting the row cuts the
 *     token off on its next request.
 *   - registration helpers for `routes/applications.ts`.
 *
 * The scope is fixed, not derived from the application's grants: a trusted
 * publisher IS the authority to publish updates for one application, and it can
 * never be more, whatever else the application holds.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { isUniqueViolation } from '@oxy.so/db';
import { getDb } from '../config/postgres';
import { accountClosureFences } from '../db/schema/accountClosureFences';
import { applications } from '../db/schema/applications';
import {
  githubTrustedPublishers,
  type GithubTrustedPublisherRow,
} from '../db/schema/githubTrustedPublishers';
import { users } from '../db/schema/users';
import type { ServiceTokenPayload } from '../middleware/serviceToken';
import { deploymentCredentialEnvironment } from '../utils/credentialEnvironment';
import {
  ApiError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
} from '../utils/error';
import { logger } from '../utils/logger';
import { tracedFetch } from '../utils/tracedFetch';
import { resolveApplicationIdFromClientId } from '../utils/resolveApplicationFromClientId';
import type { LiveAgencyServicePrincipal } from './agencyServicePrincipal.service';
import { isOwnApplicationType } from './applicationRoles.service';
import {
  GithubActionsTokenError,
  verifyGithubActionsToken,
  type GithubActionsClaims,
} from './githubActionsOidc.service';
import { mintServiceToken, SERVICE_TOKEN_EXPIRY } from './serviceTokenMint.service';
import { isSupervised } from './supervisionPolicy.service';

/** The whole authority of a trusted publisher. Never widened, never derived. */
export const TRUSTED_PUBLISHER_SCOPES = ['updates:publish'] as const;

/**
 * The prefix that tells a resolver a token's `credentialId` names a trusted
 * publisher rather than an `ApplicationCredential` or a workload binding.
 *
 * A ROUTING decision, never a trust one, exactly like `wl_`: it picks which row
 * must be found, and that lookup then has to succeed on its own terms. The
 * spaces cannot collide: credential ids are uuid v7 (or 24 hex characters for
 * pre-cutover rows) and workload handles start with `wl_`.
 */
export const TRUSTED_PUBLISHER_HANDLE_PREFIX = 'tp_';

export function trustedPublisherHandle(publisherId: string): string {
  return `${TRUSTED_PUBLISHER_HANDLE_PREFIX}${publisherId}`;
}

export function isTrustedPublisherHandle(credentialId: string): boolean {
  return credentialId.startsWith(TRUSTED_PUBLISHER_HANDLE_PREFIX);
}

/**
 * The events a publish may run for. An allowlist, so `pull_request` and
 * `pull_request_target` (which runs with the BASE ref and is the classic way
 * untrusted pull-request code reaches a privileged token), `workflow_run`,
 * `issue_comment` and every event GitHub adds later are refused by default.
 */
export const TRUSTED_PUBLISHER_EVENTS: ReadonlySet<string> = new Set(['push', 'workflow_dispatch']);

/**
 * The audience a token must name: this API's own public origin, the value every
 * other issuer/audience in the API reads (`OXY_API_URL`, `https://api.oxy.so`
 * by default). Read per call so a test can set it.
 */
export function githubActionsAudience(): string {
  return (process.env.OXY_API_URL ?? 'https://api.oxy.so').replace(/\/$/, '');
}

/** Whether `claims` satisfy exactly this publisher rule. */
export function matchesTrustedPublisher(
  publisher: Pick<GithubTrustedPublisherRow, 'repository' | 'repositoryId' | 'ref' | 'workflow'>,
  claims: GithubActionsClaims,
): boolean {
  const [owner] = publisher.repository.split('/');
  return (
    claims.repository.toLowerCase() === publisher.repository.toLowerCase() &&
    claims.repositoryOwner.toLowerCase() === (owner ?? '').toLowerCase() &&
    claims.repositoryId === publisher.repositoryId &&
    claims.ref === publisher.ref &&
    (publisher.workflow === null ||
      claims.workflowRef === `${claims.repository}/${publisher.workflow}@${claims.ref}`)
  );
}

export interface GithubActionsExchangeResult {
  token: string;
  expiresIn: number;
  appName: string;
}

/** `POST /auth/service-token/github-actions`. Throws an `ApiError` with a bounded `reason`. */
export async function exchangeGithubActionsToken(input: {
  clientId: string;
  token: string;
}): Promise<GithubActionsExchangeResult> {
  let claims: GithubActionsClaims;
  try {
    claims = await verifyGithubActionsToken(input.token, { audience: githubActionsAudience() });
  } catch (error: unknown) {
    if (error instanceof GithubActionsTokenError) {
      throw new UnauthorizedError(error.message, { reason: error.reason });
    }
    throw error;
  }

  if (!TRUSTED_PUBLISHER_EVENTS.has(claims.eventName)) {
    throw new ForbiddenError(`GitHub event "${claims.eventName}" may not publish`, {
      reason: 'event_not_allowed',
    });
  }

  const applicationId = await resolveApplicationIdFromClientId(input.clientId);
  const [app] = applicationId
    ? await getDb()
        .select({
          id: applications.id,
          name: applications.name,
          ownerAccountId: applications.ownerAccountId,
        })
        .from(applications)
        .where(and(eq(applications.id, applicationId), eq(applications.status, 'active')))
        .limit(1)
    : [];
  if (!app) {
    throw new UnauthorizedError('Unknown client id', { reason: 'unknown_client' });
  }
  // `updates:publish` is own-tenant authority (an application's own updates,
  // served to its own installs), so no platform-trust gate applies: a
  // third-party application publishes through the publishers it registered,
  // an Oxy application through the ones declared in code.
  if (await isSupervised(app.ownerAccountId)) {
    throw new ForbiddenError('Supervised accounts cannot authorize service credentials', {
      reason: 'owner_supervised',
    });
  }

  const publishers = await getDb()
    .select()
    .from(githubTrustedPublishers)
    .where(eq(githubTrustedPublishers.applicationId, app.id));
  const publisher = publishers.find((candidate) => matchesTrustedPublisher(candidate, claims));
  if (!publisher) {
    logger.warn('[TrustedPublishing] No trusted publisher matched', {
      applicationId: app.id,
      repository: claims.repository,
      repositoryId: claims.repositoryId,
      ref: claims.ref,
      workflowRef: claims.workflowRef,
      eventName: claims.eventName,
    });
    throw new ForbiddenError(
      `No trusted publisher of this application matches ${claims.repository} at ${claims.ref}`,
      { reason: 'no_trusted_publisher' },
    );
  }

  const token = mintServiceToken({
    appId: app.id,
    appName: app.name,
    credentialId: trustedPublisherHandle(publisher.id),
    ownerAccountId: app.ownerAccountId,
    authority: 'external',
    tier: 'external',
    scopes: [...TRUSTED_PUBLISHER_SCOPES],
    environment: deploymentCredentialEnvironment(),
  });

  const usedAt = new Date();
  await getDb()
    .update(githubTrustedPublishers)
    .set({ lastUsedAt: usedAt })
    .where(eq(githubTrustedPublishers.id, publisher.id));
  await getDb().update(applications).set({ lastUsedAt: usedAt }).where(eq(applications.id, app.id));

  logger.info('[TrustedPublishing] Service token issued', {
    applicationId: app.id,
    publisherId: publisher.id,
    repository: claims.repository,
    ref: claims.ref,
    workflowRef: claims.workflowRef,
    eventName: claims.eventName,
    sha: claims.sha,
    runId: claims.runId,
    expiresIn: SERVICE_TOKEN_EXPIRY,
  });

  return { token, expiresIn: SERVICE_TOKEN_EXPIRY, appName: app.name };
}

/**
 * The live principal behind a `tp_` token, or null. Every refusal is a
 * revocation taking effect on the next request: the row was deleted or moved,
 * the application is no longer active or trusted, the owner was suspended,
 * fenced or supervised, or the token was minted for another deployment.
 */
export async function resolveLiveTrustedPublisherPrincipal(
  token: ServiceTokenPayload,
): Promise<LiveAgencyServicePrincipal | null> {
  if (token.authority === 'first_party' || !isTrustedPublisherHandle(token.credentialId)) {
    return null;
  }
  const publisherId = token.credentialId.slice(TRUSTED_PUBLISHER_HANDLE_PREFIX.length);
  const [row] = await getDb()
    .select({
      applicationId: applications.id,
      ownerAccountId: applications.ownerAccountId,
      applicationStatus: applications.status,
      ownerAccountStatus: users.accountStatus,
      ownerClosureFence: accountClosureFences.accountId,
    })
    .from(githubTrustedPublishers)
    .innerJoin(applications, eq(applications.id, githubTrustedPublishers.applicationId))
    .innerJoin(users, eq(users.id, applications.ownerAccountId))
    .leftJoin(accountClosureFences, eq(accountClosureFences.accountId, users.id))
    .where(
      and(
        eq(githubTrustedPublishers.id, publisherId),
        eq(githubTrustedPublishers.applicationId, token.appId),
      ),
    )
    .limit(1);
  if (
    row?.applicationStatus !== 'active' ||
    row.ownerAccountStatus !== 'active' ||
    row.ownerClosureFence !== null ||
    row.ownerAccountId !== token.ownerAccountId ||
    token.environment !== deploymentCredentialEnvironment()
  ) {
    return null;
  }
  if (await isSupervised(row.ownerAccountId)) return null;
  const allowed: readonly string[] = TRUSTED_PUBLISHER_SCOPES;
  return {
    applicationId: row.applicationId,
    credentialId: token.credentialId,
    ownerAccountId: row.ownerAccountId,
    authority: 'external',
    scopes: (token.scopes ?? []).filter((scope) => allowed.includes(scope)),
    capabilities: [],
  };
}

// ============================================================================
// Registration
// ============================================================================

const GITHUB_API_TIMEOUT_MS = 5_000;

/**
 * GitHub's canonical name and numeric id for a public repository.
 *
 * Read anonymously from the REST API, which answers for public repositories
 * only; a private one is a 404 here and must be registered with its id.
 */
export async function resolvePublicGithubRepository(
  repository: string,
  fetchImpl: typeof fetch = (input, init) => tracedFetch(input, init),
): Promise<{ repository: string; repositoryId: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${repository}`, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'oxy-api',
        'x-github-api-version': '2022-11-28',
      },
      signal: controller.signal,
    });
  } catch (error: unknown) {
    throw new ApiError(
      502,
      'GitHub could not be reached to read the repository id; pass repositoryId',
      undefined,
      { reason: 'github_unreachable', cause: error instanceof Error ? error.message : 'unknown' },
    );
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 404) {
    throw new BadRequestError(
      'GitHub has no public repository by that name; a private repository needs repositoryId',
      { reason: 'repository_not_found' },
    );
  }
  if (!response.ok) {
    throw new ApiError(
      502,
      `GitHub answered ${response.status} reading the repository; pass repositoryId`,
      undefined,
      { reason: 'github_unavailable' },
    );
  }
  const body = (await response.json()) as { id?: unknown; full_name?: unknown };
  if (
    typeof body.id !== 'number' ||
    !Number.isSafeInteger(body.id) ||
    body.id <= 0 ||
    typeof body.full_name !== 'string'
  ) {
    throw new ApiError(502, 'GitHub returned an unexpected repository record', undefined, {
      reason: 'github_unavailable',
    });
  }
  // A renamed repository redirects to its new name, which is the name GitHub
  // will put in the token. Register what was asked for, or say what to ask for.
  if (body.full_name.toLowerCase() !== repository.toLowerCase()) {
    throw new BadRequestError(`GitHub names this repository ${body.full_name}; register that`, {
      reason: 'repository_renamed',
    });
  }
  return { repository: body.full_name, repositoryId: String(body.id) };
}

export interface TrustedPublisherView {
  id: string;
  provider: 'github';
  repository: string;
  repositoryId: string;
  ref: string;
  workflow: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export function serializeTrustedPublisher(row: GithubTrustedPublisherRow): TrustedPublisherView {
  return {
    id: row.id,
    provider: 'github',
    repository: row.repository,
    repositoryId: row.repositoryId,
    ref: row.ref,
    workflow: row.workflow,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

export async function listTrustedPublishers(
  applicationId: string,
): Promise<GithubTrustedPublisherRow[]> {
  return getDb()
    .select()
    .from(githubTrustedPublishers)
    .where(eq(githubTrustedPublishers.applicationId, applicationId))
    .orderBy(githubTrustedPublishers.createdAt);
}

/** The refusal code for a Console/API write to an Oxy application's publishers. */
export const FIRST_PARTY_TRUSTED_PUBLISHERS_IN_CODE = 'FIRST_PARTY_TRUSTED_PUBLISHERS_IN_CODE';

/**
 * Refuse an API write to one of Oxy's own applications: its publishers are
 * declared in code (`trustedPublishers` in `seedOxyApplicationsSpecs.ts`) and
 * applied by the seed, as its operator keys are (ADR 0056).
 */
export function refuseOwnApplicationPublisherWrite(application: { type: string }): void {
  if (isOwnApplicationType(application.type)) {
    throw new ApiError(
      409,
      "This is one of Oxy's own applications: its trusted publishers are declared in code (ADR 0057), not registered through the API",
      FIRST_PARTY_TRUSTED_PUBLISHERS_IN_CODE,
    );
  }
}

export async function registerTrustedPublisher(input: {
  application: Pick<typeof applications.$inferSelect, 'id' | 'type'>;
  repository: string;
  repositoryId?: string;
  ref?: string;
  workflow?: string;
  actorUserId: string;
}): Promise<GithubTrustedPublisherRow> {
  refuseOwnApplicationPublisherWrite(input.application);
  const resolved =
    input.repositoryId === undefined
      ? await resolvePublicGithubRepository(input.repository)
      : { repository: input.repository, repositoryId: input.repositoryId };
  try {
    const [row] = await getDb()
      .insert(githubTrustedPublishers)
      .values({
        applicationId: input.application.id,
        repository: resolved.repository,
        repositoryId: resolved.repositoryId,
        ref: input.ref ?? 'refs/heads/main',
        workflow: input.workflow ?? null,
        createdByUserId: input.actorUserId,
      })
      .returning();
    logger.info('[TrustedPublishing] Trusted publisher registered', {
      applicationId: input.application.id,
      publisherId: row.id,
      repository: row.repository,
      repositoryId: row.repositoryId,
      ref: row.ref,
      workflow: row.workflow,
      by: input.actorUserId,
    });
    return row;
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      throw new ConflictError('This trusted publisher is already registered');
    }
    throw error;
  }
}

/** Delete one publisher of `applicationId`; returns false when there was none. */
export async function deleteTrustedPublisher(input: {
  application: Pick<typeof applications.$inferSelect, 'id' | 'type'>;
  publisherId: string;
  actorUserId: string;
}): Promise<boolean> {
  refuseOwnApplicationPublisherWrite(input.application);
  const deleted = await getDb()
    .delete(githubTrustedPublishers)
    .where(
      and(
        eq(githubTrustedPublishers.id, input.publisherId),
        eq(githubTrustedPublishers.applicationId, input.application.id),
      ),
    )
    .returning({
      id: githubTrustedPublishers.id,
      repository: githubTrustedPublishers.repository,
    });
  if (deleted.length === 0) return false;
  logger.info('[TrustedPublishing] Trusted publisher deleted', {
    applicationId: input.application.id,
    publisherId: input.publisherId,
    repository: deleted[0]?.repository,
    by: input.actorUserId,
  });
  return true;
}

// ============================================================================
// Oxy's own applications: declared in code, applied by the seed
// ============================================================================

/** One publisher an Oxy application declares in `seedOxyApplicationsSpecs.ts`. */
export interface DeclaredTrustedPublisher {
  readonly repository: string;
  readonly repositoryId: string;
  readonly ref: string;
  readonly workflow: string;
}

function publisherRuleKey(rule: { repositoryId: string; ref: string; workflow: string | null }) {
  return `${rule.repositoryId}\u0000${rule.ref}\u0000${rule.workflow ?? ''}`;
}

export interface TrustedPublisherDeclarationPlan {
  readonly add: readonly DeclaredTrustedPublisher[];
  readonly rename: readonly { id: string; from: string; to: string }[];
  readonly remove: readonly {
    id: string;
    repository: string;
    ref: string;
    workflow: string | null;
  }[];
}

/**
 * Make an Oxy application's publishers EXACTLY `declared` (absent = none), the
 * way the seed makes its operator keys exactly the registry's: a missing rule
 * is added, an undeclared one deleted (its tokens stop at their next request),
 * and a repository GitHub renamed under the same id takes the declared name.
 * One transaction; a dry run plans and writes nothing.
 */
export async function declareFirstPartyTrustedPublishers(input: {
  applicationId: string;
  declared: readonly DeclaredTrustedPublisher[];
  actorUserId: string;
  dryRun: boolean;
}): Promise<TrustedPublisherDeclarationPlan> {
  return getDb().transaction(async (tx) => {
    // Serialize concurrent seeds on the application row.
    await tx
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.id, input.applicationId))
      .for('update');
    const existing = await tx
      .select()
      .from(githubTrustedPublishers)
      .where(eq(githubTrustedPublishers.applicationId, input.applicationId));
    const existingByKey = new Map(existing.map((row) => [publisherRuleKey(row), row]));
    const declaredKeys = new Set(input.declared.map(publisherRuleKey));

    const add = input.declared.filter((rule) => !existingByKey.has(publisherRuleKey(rule)));
    const rename = input.declared.flatMap((rule) => {
      const row = existingByKey.get(publisherRuleKey(rule));
      return row && row.repository !== rule.repository
        ? [{ id: row.id, from: row.repository, to: rule.repository }]
        : [];
    });
    const remove = existing
      .filter((row) => !declaredKeys.has(publisherRuleKey(row)))
      .map(({ id, repository, ref, workflow }) => ({ id, repository, ref, workflow }));

    if (!input.dryRun) {
      if (remove.length > 0) {
        await tx.delete(githubTrustedPublishers).where(
          inArray(
            githubTrustedPublishers.id,
            remove.map((row) => row.id),
          ),
        );
      }
      for (const { id, to } of rename) {
        await tx
          .update(githubTrustedPublishers)
          .set({ repository: to })
          .where(eq(githubTrustedPublishers.id, id));
      }
      if (add.length > 0) {
        await tx.insert(githubTrustedPublishers).values(
          add.map((rule) => ({
            applicationId: input.applicationId,
            repository: rule.repository,
            repositoryId: rule.repositoryId,
            ref: rule.ref,
            workflow: rule.workflow,
            createdByUserId: input.actorUserId,
          })),
        );
      }
    }
    return { add, rename, remove };
  });
}
