/**
 * Verify the person/session and application attribution without authorizing
 * inference or choosing a payer. A shared public client ID proves no app authority.
 * The legacy economic wrapper explicitly retains its prior cached-session mode;
 * identity assertions use live session/context validation and propagate outages.
 */
import type { InferenceEnvironment } from '@oxy.so/contracts';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import { applications } from '../db/schema/applications';
import { isCredentialUsable } from '../utils/credentialUsability';
import { isTrustedApplication } from '../utils/trustedApplication';
import sessionService from './session.service';

/** The bearer prefix of a session presented with its application's public client id. */
export const PRESENTED_SESSION_PREFIX = 'oxy_session:';

const PUBLIC_CLIENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * `authentication`: the bearer is not a live session (answered
 * `authentication_failed`). `unattributable`: a live session that names no
 * live application attribution (answered `permission_denied`).
 */
export type ProductSessionIdentityAuthentication =
  | {
      readonly ok: true;
      readonly identity: ProductSessionIdentity;
      readonly applicationTrusted: boolean;
    }
  | {
      readonly ok: false;
      readonly refusal: 'authentication' | 'unattributable';
      readonly reason: string;
    };

export interface ProductSessionIdentity {
  readonly authority: 'session';
  readonly lane: 'product_session';
  readonly applicationId: string;
  readonly credentialId: string;
  readonly applicationOwnerAccountId: string;
  readonly environment: InferenceEnvironment;
  readonly applicationClass: string | null;
  readonly applicationIsInternal: boolean | null;
  readonly verifiedRequester: {
    readonly subjectAccountId: string;
    readonly principalUserId: string;
  };
  readonly applicationBinding: 'session' | 'platform' | 'public_client_id';
}

export function isPresentedSession(credential: string): boolean {
  return credential.startsWith(PRESENTED_SESSION_PREFIX);
}

type Presented =
  | { readonly ok: true; readonly clientId: string | undefined; readonly token: string }
  | { readonly ok: false };

function parsePresented(credential: string): Presented {
  if (!isPresentedSession(credential)) return { ok: true, clientId: undefined, token: credential };
  const rest = credential.slice(PRESENTED_SESSION_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator <= 0) return { ok: false };
  const clientId = rest.slice(0, separator);
  const token = rest.slice(separator + 1);
  return PUBLIC_CLIENT_ID.test(clientId) && token.length > 0
    ? { ok: true, clientId, token }
    : { ok: false };
}

const unattributable = (reason: string): ProductSessionIdentityAuthentication => ({
  ok: false,
  refusal: 'unattributable',
  reason,
});

export async function verifyProductSessionIdentity(
  credential: string,
  options: { readonly liveSession?: boolean } = {},
): Promise<ProductSessionIdentityAuthentication> {
  const presented = parsePresented(credential);
  if (!presented.ok) {
    return { ok: false, refusal: 'authentication', reason: 'session_malformed' };
  }
  const validation = await sessionService.validateSession(
    presented.token,
    options.liveSession === false ? {} : { liveSession: true, throwOnError: true },
  );
  if (validation === null) {
    return { ok: false, refusal: 'authentication', reason: 'session_invalid' };
  }
  const identity = validation.token;

  const shared = identity.applicationId === null;
  // An application token (ADR 0058) names its application by `azp`, which
  // validation re-checked against the registry and the platform credential.
  // A client id presented beside it must be that same one.
  const host = shared ? (identity.host ?? null) : null;
  if (host && presented.clientId !== undefined && presented.clientId !== host.clientId) {
    return unattributable('session_client_mismatch');
  }
  if (shared && !host && presented.clientId === undefined) return unattributable('session_unbound');
  if (!shared && identity.clientId === null) return unattributable('session_unbound');
  if (!shared && presented.clientId !== undefined && presented.clientId !== identity.clientId) {
    return unattributable('session_client_mismatch');
  }
  const clientId = host ? host.clientId : shared ? presented.clientId : identity.clientId;
  if (clientId === undefined || clientId === null) return unattributable('session_unbound');

  const [row] = await getDb()
    .select({
      applicationId: applications.id,
      credentialId: applicationCredentials.id,
      credentialType: applicationCredentials.type,
      credentialStatus: applicationCredentials.status,
      credentialExpiresAt: applicationCredentials.expiresAt,
      environment: applicationCredentials.environment,
      applicationStatus: applications.status,
      ownerAccountId: applications.ownerAccountId,
      type: applications.type,
      isOfficial: applications.isOfficial,
      isInternal: applications.isInternal,
    })
    .from(applicationCredentials)
    .innerJoin(applications, eq(applications.id, applicationCredentials.applicationId))
    .where(
      and(
        eq(applicationCredentials.publicKey, clientId),
        ...(identity.applicationId === null
          ? []
          : [eq(applicationCredentials.applicationId, identity.applicationId)]),
      ),
    )
    .limit(1);
  if (
    row === undefined ||
    row.applicationStatus !== 'active' ||
    (shared
      ? row.credentialType !== 'public'
      : row.credentialType !== 'public' && row.credentialType !== 'confidential') ||
    !isCredentialUsable({ status: row.credentialStatus, expiresAt: row.credentialExpiresAt })
  ) {
    return unattributable('session_application_unavailable');
  }

  return {
    ok: true,
    applicationTrusted: isTrustedApplication({
      isOfficial: row.isOfficial,
      isInternal: row.isInternal,
      type: row.type,
    }),
    identity: {
      authority: 'session',
      lane: 'product_session',
      applicationId: row.applicationId,
      credentialId: row.credentialId,
      applicationOwnerAccountId: row.ownerAccountId,
      environment: row.environment,
      applicationClass: row.type,
      applicationIsInternal: row.isInternal,
      verifiedRequester: {
        subjectAccountId: identity.subjectAccountId,
        principalUserId: identity.principalUserId,
      },
      // A public client ID names an app; it does not authenticate that app.
      applicationBinding: !shared ? 'session' : host ? 'platform' : 'public_client_id',
    },
  };
}
