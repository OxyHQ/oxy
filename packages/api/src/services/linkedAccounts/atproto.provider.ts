/**
 * Proving ownership of a Bluesky / atproto account with atproto OAuth, without
 * keeping the token.
 *
 * Oxy is a PUBLIC client (`token_endpoint_auth_method: none`, DPoP-bound
 * tokens): no long-lived client key exists to custody. `client_id` is the URL of
 * the client-metadata document this API serves at
 * `GET /linked-accounts/atproto/client-metadata.json`.
 *
 * The official `@atproto/oauth-client-node` does the protocol work — PAR, PKCE,
 * DPoP, and, on the callback, checking that the token's `sub` DID really is
 * served by the authorization server that issued it. Oxy wires its two stores:
 *
 * - **State store → `linked_account_oauth_challenges`.** The row is minted
 *   first (user, return URL); its id travels as the library's `appState`, and
 *   the library's own `state` and per-flow data are bound to it by `set`. `get`
 *   SPENDS the row (single use, expiry filtered) and wipes the secrets.
 * - **Session store → a per-process `Map`, emptied in the same request.** The
 *   library insists on storing the session it just created; Oxy signs it out
 *   (revoking the token at the authorization server) and deletes the entry
 *   before the callback returns. No token is ever written to the database.
 *
 * All the library's network access goes through the linked-accounts transport
 * (`safeFetch`), because the PDS and authorization server it contacts are named
 * by a DID document the user controls.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../../config/postgres';
import { linkedAccountOauthChallenges } from '../../db/schema/userLinkedAccounts';
import { logger } from '../../utils/logger';
import { bindProviderState, discardChallenge, mintChallenge, spendChallenge } from './challenges';
import {
  LinkedAccountCallbackFailure,
  LinkedAccountStartRefusal,
  linkedAccountCallbackUrl,
  oxyApiOrigin,
  type VerifiedExternalAccount,
} from './common';
import { linkedAccountTransport } from './http';
import { loadAtprotoOAuthModule } from './atprotoClientLoader';

const ATPROTO_LINK_SCOPE = 'atproto';

/** The structural slice of `NodeOAuthClient` this module uses (test fakes implement it). */
export interface AtprotoOAuthClientLike {
  authorize(input: string, options?: { state?: string; scope?: string }): Promise<URL>;
  callback(params: URLSearchParams): Promise<{ session: AtprotoSessionLike; state: string | null }>;
  oauthResolver: {
    identityResolver: {
      resolve(identifier: string): Promise<{ did: string; handle: string; didDoc: { service?: unknown } }>;
    };
  };
}

export interface AtprotoSessionLike {
  did: string;
  signOut(): Promise<void>;
}

interface SimpleStore<V> {
  get(key: string): Promise<V | undefined>;
  set(key: string, value: V): Promise<void>;
  del(key: string): Promise<void>;
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * The client metadata document. In local development (an `http://localhost`
 * API) atproto's loopback-client form is used instead, which needs no hosted
 * document — the authorization server derives the metadata from the client_id.
 */
export function atprotoClientMetadata(): Record<string, unknown> {
  const origin = oxyApiOrigin();
  const redirectUri = linkedAccountCallbackUrl('atproto');
  if (isLoopbackOrigin(origin)) {
    const loopbackRedirect = redirectUri.replace('://localhost', '://127.0.0.1');
    const clientId = `http://localhost?${new URLSearchParams({ redirect_uri: loopbackRedirect, scope: ATPROTO_LINK_SCOPE })}`;
    return {
      client_id: clientId,
      redirect_uris: [loopbackRedirect],
      scope: ATPROTO_LINK_SCOPE,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
      dpop_bound_access_tokens: true,
    };
  }
  return {
    client_id: `${origin}/linked-accounts/atproto/client-metadata.json`,
    client_name: 'Oxy',
    client_uri: 'https://oxy.so',
    redirect_uris: [redirectUri],
    scope: ATPROTO_LINK_SCOPE,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'web',
    dpop_bound_access_tokens: true,
  };
}

/** The in-memory session store. Exported so tests can assert it ends empty. */
export const atprotoSessionsInFlight = new Map<string, unknown>();

const sessionStore: SimpleStore<unknown> = {
  async get(key) {
    return atprotoSessionsInFlight.get(key);
  },
  async set(key, value) {
    atprotoSessionsInFlight.set(key, value);
  },
  async del(key) {
    atprotoSessionsInFlight.delete(key);
  },
};

const stateStore: SimpleStore<Record<string, unknown>> = {
  async set(key, value) {
    const challengeId = typeof value.appState === 'string' ? value.appState : null;
    if (!challengeId) throw new Error('atproto state carries no challenge id');
    let host: string | null = null;
    if (typeof value.iss === 'string') {
      try {
        host = new URL(value.iss).hostname;
      } catch {
        host = null;
      }
    }
    const bound = await bindProviderState(challengeId, key, value, host);
    if (!bound) throw new Error('linking challenge is no longer open');
  },
  async get(key) {
    const spent = await spendChallenge('atproto', key);
    if (!spent?.providerState) return undefined;
    // The row id IS the appState — restored from the row rather than trusted
    // from the stored blob.
    return { ...spent.providerState, appState: spent.id };
  },
  async del() {
    // `get` already spent the row; nothing is left to delete.
  },
};

let clientPromise: Promise<AtprotoOAuthClientLike> | null = null;

async function buildClient(): Promise<AtprotoOAuthClientLike> {
  const { NodeOAuthClient } = await loadAtprotoOAuthModule();
  const client = new NodeOAuthClient({
    // The document this API serves is exactly this object, so no fetch of our
    // own metadata is needed at startup.
    clientMetadata: atprotoClientMetadata() as never,
    stateStore: stateStore as never,
    sessionStore: sessionStore as never,
    fetch: linkedAccountTransport().fetch,
    // The library's default handle resolver refuses to construct outside Node
    // (it checks `process.versions.undici` for its SSRF dispatcher), so under
    // Bun — `bun --watch` in development — handles are resolved through the
    // public Bluesky AppView instead. Production runs Node and keeps the
    // default DNS + well-known resolver. Ownership never rests on the handle:
    // it rests on the token's verified `sub` DID.
    ...(process.versions.bun ? { handleResolver: 'https://public.api.bsky.app' } : {}),
    // One process holds each session for one request; the library's warning
    // about a missing lock is about concurrent refreshes, which never happen here.
    requestLock: async (_name: string, fn: () => unknown) => fn(),
  } as never);
  return client as unknown as AtprotoOAuthClientLike;
}

function atprotoClient(): Promise<AtprotoOAuthClientLike> {
  if (!clientPromise) {
    clientPromise = buildClient().catch((error) => {
      clientPromise = null;
      throw error;
    });
  }
  return clientPromise;
}

/**
 * The two stores the library is given, for a test double of the library to
 * drive exactly as the real one does.
 */
export const atprotoStoresForTesting = { stateStore, sessionStore };

/** Test seam: provide a client (or `null` to rebuild from the loader). */
export function setAtprotoClientForTesting(client: AtprotoOAuthClientLike | null): void {
  clientPromise = client ? Promise.resolve(client) : null;
}

export interface AtprotoStartInput {
  userId: string;
  handle: string;
  clientApplicationId: string;
  returnTo: string;
}

export async function startAtprotoLink(input: AtprotoStartInput): Promise<{ authorizeUrl: string; expiresAt: Date }> {
  const identifier = input.handle.trim().replace(/^@/, '');
  if (!identifier) throw new LinkedAccountStartRefusal('handle is required');
  const challenge = await mintChallenge({
    userId: input.userId,
    network: 'atproto',
    clientApplicationId: input.clientApplicationId,
    returnTo: input.returnTo,
  });
  try {
    const client = await atprotoClient();
    const url = await client.authorize(identifier, { state: challenge.id, scope: ATPROTO_LINK_SCOPE });
    return { authorizeUrl: url.toString(), expiresAt: challenge.expiresAt };
  } catch (error) {
    await discardChallenge(challenge.id);
    logger.info('[LinkedAccounts] atproto authorize failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new LinkedAccountStartRefusal('that handle could not be resolved to a Bluesky account');
  }
}

function pdsHost(didDoc: { service?: unknown }): string | null {
  if (!Array.isArray(didDoc.service)) return null;
  for (const service of didDoc.service as Array<Record<string, unknown>>) {
    const id = typeof service?.id === 'string' ? service.id : '';
    if (id === '#atproto_pds' || id.endsWith('#atproto_pds')) {
      try {
        return new URL(String(service.serviceEndpoint)).hostname;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export interface AtprotoCallbackResult {
  challengeId: string;
  returnTo: string;
  account: VerifiedExternalAccount;
}

/**
 * Complete the flow. Returns the verified DID plus the challenge it spent; a
 * failure names the challenge when the library could, so the caller can still
 * return the browser to the right place.
 */
export async function completeAtprotoLink(
  params: URLSearchParams,
): Promise<AtprotoCallbackResult | { failure: LinkedAccountCallbackFailure; challengeId: string | null }> {
  const client = await atprotoClient();
  let session: AtprotoSessionLike | null = null;
  let challengeId: string | null = null;
  try {
    const result = await client.callback(params);
    session = result.session;
    challengeId = result.state;
  } catch (error) {
    const state = (error as { state?: unknown })?.state;
    const failedChallenge = typeof state === 'string' ? state : null;
    const denied = params.get('error') === 'access_denied';
    return {
      failure: new LinkedAccountCallbackFailure(
        denied ? 'access_denied' : 'verification_failed',
        error instanceof Error ? error.message : 'atproto callback failed',
      ),
      challengeId: failedChallenge,
    };
  }

  try {
    if (!challengeId) {
      return { failure: new LinkedAccountCallbackFailure('verification_failed', 'callback carried no challenge'), challengeId: null };
    }
    const did = session.did;
    let handle = did;
    let host: string | null = null;
    try {
      const identity = await client.oauthResolver.identityResolver.resolve(did);
      if (identity.did === did && identity.handle && identity.handle !== 'handle.invalid') handle = identity.handle;
      host = pdsHost(identity.didDoc);
    } catch (error) {
      logger.info('[LinkedAccounts] atproto identity lookup failed after a verified callback', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const [row] = await getDb()
      .select({
        returnTo: linkedAccountOauthChallenges.returnTo,
        host: linkedAccountOauthChallenges.host,
      })
      .from(linkedAccountOauthChallenges)
      .where(eq(linkedAccountOauthChallenges.id, challengeId))
      .limit(1);
    if (!row) {
      return { failure: new LinkedAccountCallbackFailure('verification_failed', 'challenge vanished'), challengeId };
    }
    return {
      challengeId,
      returnTo: row.returnTo,
      account: {
        network: 'atproto',
        accountKey: did,
        actorUri: did,
        handle,
        host: host ?? row.host ?? 'bsky.social',
      },
    };
  } finally {
    // The token's only job is done. Revoke it at the authorization server and
    // make sure nothing of the session outlives this request.
    const did = session?.did;
    try {
      await session?.signOut();
    } catch (error) {
      logger.warn('[LinkedAccounts] atproto sign-out failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (did) atprotoSessionsInFlight.delete(did);
  }
}
