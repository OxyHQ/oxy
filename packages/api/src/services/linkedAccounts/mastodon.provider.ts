/**
 * Proving ownership of an account on any Mastodon-API server (Mastodon,
 * GoToSocial, Pleroma, Akkoma) by OAuth, without keeping the token.
 *
 * 1. `ensureAppRegistration` — Oxy's own client at that instance
 *    (`POST /api/v1/apps`), cached in `mastodon_app_registrations`.
 * 2. `startMastodonLink` — the authorize URL, with `state` and PKCE (S256).
 * 3. `completeMastodonLink` — exchange the code, read
 *    `GET /api/v1/accounts/verify_credentials`, resolve the ActivityPub actor
 *    through the instance's own WebFinger, then revoke the token
 *    (`POST /oauth/revoke`) and let it go out of scope. Nothing about the token
 *    is stored anywhere.
 *
 * The only scope requested is `read:accounts` — enough to name the account,
 * nothing more.
 */

import { eq, sql } from 'drizzle-orm';
import { getDb } from '../../config/postgres';
import { mastodonAppRegistrations } from '../../db/schema/userLinkedAccounts';
import { logger } from '../../utils/logger';
import { mintChallenge, pkceChallenge, randomToken, type SpentChallenge } from './challenges';
import {
  LinkedAccountCallbackFailure,
  LinkedAccountStartRefusal,
  linkedAccountCallbackUrl,
  type VerifiedExternalAccount,
} from './common';
import { linkedAccountTransport, readJson } from './http';

const MASTODON_LINK_SCOPES = 'read:accounts';

const CLIENT_NAME = 'Oxy';
const CLIENT_WEBSITE = 'https://oxy.so';

/** A DNS hostname: labels of letters, digits and hyphens, at least one dot. */
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/**
 * The instance host from what a person would type: `mastodon.social`,
 * `https://mastodon.social`, `@nate@mastodon.social` or `nate@mastodon.social`.
 * Returns `null` for anything that is not a plain public DNS name — IP
 * literals, ports, credentials and paths are refused here, before any network
 * call, and the SSRF guard still checks what the name resolves to.
 */
function parseInstanceHost(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith('https://')) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (url.username || url.password || url.port || (url.pathname !== '/' && url.pathname !== '')) return null;
    value = url.hostname;
  } else if (value.includes('://')) {
    return null;
  } else {
    value = value.replace(/^@/, '');
    const at = value.lastIndexOf('@');
    if (at !== -1) value = value.slice(at + 1);
  }
  value = value.replace(/\.$/, '');
  return HOSTNAME.test(value) ? value : null;
}

interface AppRegistration {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Oxy's client at `host`, registering (or re-registering after a config change)
 * when needed. Serialized per instance with a transaction-scoped advisory lock,
 * so concurrent first starts at one instance register once and share it rather
 * than each overwriting the other's client (which would fail the loser's token
 * exchange).
 */
async function ensureAppRegistration(host: string): Promise<AppRegistration> {
  const redirectUri = linkedAccountCallbackUrl('activitypub');
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mastodon-app:${host}`}))`);
    const [existing] = await tx
      .select({
        clientId: mastodonAppRegistrations.clientId,
        clientSecret: mastodonAppRegistrations.clientSecret,
        redirectUri: mastodonAppRegistrations.redirectUri,
        scopes: mastodonAppRegistrations.scopes,
      })
      .from(mastodonAppRegistrations)
      .where(eq(mastodonAppRegistrations.host, host))
      .limit(1);
    if (existing && existing.redirectUri === redirectUri && existing.scopes === MASTODON_LINK_SCOPES) {
      return existing;
    }

    const response = await linkedAccountTransport().fetch(`https://${host}/api/v1/apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: redirectUri,
        scopes: MASTODON_LINK_SCOPES,
        website: CLIENT_WEBSITE,
      }),
    });
    const body = (await readJson(response)) as { client_id?: unknown; client_secret?: unknown } | null;
    if (!response.ok || typeof body?.client_id !== 'string' || typeof body.client_secret !== 'string') {
      // The server answered and did not register Oxy. A 5xx or 429 is the
      // server being down or busy; anything else (a 4xx, a 2xx that is not a
      // Mastodon app) is a refusal — often a server that is not Mastodon-API.
      const unavailable = response.status >= 500 || response.status === 429;
      logger.warn('[LinkedAccounts] Mastodon app registration refused', { host, status: response.status });
      throw new LinkedAccountStartRefusal(
        unavailable ? 'provider_unavailable' : 'provider_rejected',
        `the server did not accept an app registration (HTTP ${response.status}); is it a Mastodon-compatible server?`,
      );
    }
    const registration = { clientId: body.client_id, clientSecret: body.client_secret, redirectUri };
    await tx
      .insert(mastodonAppRegistrations)
      .values({ host, ...registration, scopes: MASTODON_LINK_SCOPES })
      .onConflictDoUpdate({
        target: mastodonAppRegistrations.host,
        set: { ...registration, scopes: MASTODON_LINK_SCOPES },
      });
    return registration;
  });
}

interface StartInput {
  userId: string;
  instance: string;
  clientApplicationId: string;
  returnTo: string;
}

export async function startMastodonLink(input: StartInput): Promise<{ authorizeUrl: string; expiresAt: Date }> {
  const host = parseInstanceHost(input.instance);
  if (!host) throw new LinkedAccountStartRefusal('instance_invalid', 'instance must be a server name such as mastodon.social');
  try {
    await linkedAccountTransport().assertPublicHost(host);
  } catch {
    throw new LinkedAccountStartRefusal('instance_unreachable', 'instance is not a reachable public server');
  }

  let registration: AppRegistration;
  try {
    registration = await ensureAppRegistration(host);
  } catch (error) {
    if (error instanceof LinkedAccountStartRefusal) throw error;
    logger.warn('[LinkedAccounts] Mastodon app registration failed', {
      host,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new LinkedAccountStartRefusal('instance_unreachable', 'instance could not be reached');
  }

  const state = randomToken();
  const verifier = randomToken();
  const challenge = await mintChallenge({
    userId: input.userId,
    network: 'activitypub',
    state,
    host,
    pkceVerifier: verifier,
    clientApplicationId: input.clientApplicationId,
    returnTo: input.returnTo,
  });

  const url = new URL(`https://${host}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', registration.clientId);
  url.searchParams.set('redirect_uri', registration.redirectUri);
  url.searchParams.set('scope', MASTODON_LINK_SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', pkceChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return { authorizeUrl: url.toString(), expiresAt: challenge.expiresAt };
}

interface MastodonAccount {
  id?: unknown;
  username?: unknown;
  acct?: unknown;
  url?: unknown;
  uri?: unknown;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/** WebFinger `acct:<username>@<domain>` at `domain`: its subject and `self` actor link. */
async function webfinger(domain: string, username: string): Promise<{ subject: string | null; self: string | null }> {
  const resource = encodeURIComponent(`acct:${username}@${domain}`);
  const response = await linkedAccountTransport().fetch(`https://${domain}/.well-known/webfinger?resource=${resource}`, {
    headers: { Accept: 'application/jrd+json, application/json' },
  });
  const jrd = (await readJson(response)) as { subject?: unknown; links?: unknown } | null;
  if (!response.ok || !jrd) return { subject: null, self: null };
  const subject = typeof jrd.subject === 'string' ? jrd.subject.replace(/^acct:/i, '').toLowerCase() : null;
  const links = Array.isArray(jrd.links) ? (jrd.links as Array<Record<string, unknown>>) : [];
  const self = links.find((link) => {
    const type = typeof link?.type === 'string' ? link.type : '';
    return link?.rel === 'self' && (type.includes('activity+json') || type.includes('ld+json'));
  });
  return { subject, self: httpsUrl(self?.href) };
}

/**
 * The account's ActivityPub identity, bound to the instance that authenticated
 * it. The actor must live on `host`: an instance vouches only for its own
 * accounts, so a hostile server cannot name somebody else's actor and have it
 * published as this user's alias (or imported as their content). The account
 * key is `username@host`, unless WebFinger names a different public account
 * domain (a split-domain server) AND that domain's own WebFinger resolves the
 * same address to the same actor.
 */
async function resolveActor(host: string, username: string, account: MastodonAccount): Promise<{ accountKey: string; actorUri: string }> {
  const user = username.toLowerCase();
  let accountKey = `${user}@${host}`;
  let actorUri: string | null = null;
  try {
    const local = await webfinger(host, username);
    if (local.self && new URL(local.self).hostname === host) actorUri = local.self;
    const domain = local.subject?.startsWith(`${user}@`) ? local.subject.slice(user.length + 1) : null;
    if (actorUri && domain && domain !== host && parseInstanceHost(domain) === domain) {
      const remote = await webfinger(domain, username);
      if (remote.subject === `${user}@${domain}` && remote.self === actorUri) accountKey = remote.subject;
    }
  } catch (error) {
    logger.debug('[LinkedAccounts] WebFinger lookup failed; falling back to account.uri', {
      host,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!actorUri) {
    const uri = httpsUrl(account.uri);
    if (uri && new URL(uri).hostname === host) actorUri = uri;
  }
  if (!actorUri) {
    throw new LinkedAccountCallbackFailure('verification_failed', 'the instance did not publish an ActivityPub actor for the account');
  }
  return { accountKey, actorUri };
}

async function revokeToken(host: string, registration: AppRegistration, token: string): Promise<void> {
  try {
    const response = await linkedAccountTransport().fetch(`https://${host}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: registration.clientId,
        client_secret: registration.clientSecret,
        token,
      }).toString(),
    });
    if (!response.ok) {
      logger.warn('[LinkedAccounts] Mastodon token revoke refused', { host, status: response.status });
    }
  } catch (error) {
    // Best effort: the token is already out of scope and was never stored; the
    // worst case is a read:accounts token that lives out its own lifetime at
    // the instance, where the user can see and revoke it.
    logger.warn('[LinkedAccounts] Mastodon token revoke failed', {
      host,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Exchange, verify, revoke. Throws {@link LinkedAccountCallbackFailure}. */
export async function completeMastodonLink(challenge: SpentChallenge, code: string): Promise<VerifiedExternalAccount> {
  const host = challenge.host;
  if (!host || !challenge.pkceVerifier) {
    throw new LinkedAccountCallbackFailure('verification_failed', 'challenge is missing its instance or verifier');
  }
  const [registration] = await getDb()
    .select({
      clientId: mastodonAppRegistrations.clientId,
      clientSecret: mastodonAppRegistrations.clientSecret,
      redirectUri: mastodonAppRegistrations.redirectUri,
    })
    .from(mastodonAppRegistrations)
    .where(eq(mastodonAppRegistrations.host, host))
    .limit(1);
  if (!registration) {
    throw new LinkedAccountCallbackFailure('provider_unavailable', 'no app registration for the instance');
  }

  const fetchJson = linkedAccountTransport().fetch;
  let token: string | null = null;
  try {
    const tokenResponse = await fetchJson(`https://${host}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: registration.clientId,
        client_secret: registration.clientSecret,
        redirect_uri: registration.redirectUri,
        code_verifier: challenge.pkceVerifier,
        scope: MASTODON_LINK_SCOPES,
      }).toString(),
    });
    const tokenBody = (await readJson(tokenResponse)) as { access_token?: unknown } | null;
    if (!tokenResponse.ok || typeof tokenBody?.access_token !== 'string') {
      throw new LinkedAccountCallbackFailure('verification_failed', `token exchange failed (${tokenResponse.status})`);
    }
    token = tokenBody.access_token;

    const accountResponse = await fetchJson(`https://${host}/api/v1/accounts/verify_credentials`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const account = (await readJson(accountResponse)) as MastodonAccount | null;
    if (!accountResponse.ok || !account || typeof account.username !== 'string' || !account.username) {
      throw new LinkedAccountCallbackFailure('verification_failed', `verify_credentials failed (${accountResponse.status})`);
    }
    const { accountKey, actorUri } = await resolveActor(host, account.username, account);
    return { network: 'activitypub', accountKey, actorUri, handle: `@${accountKey}`, host };
  } catch (error) {
    if (error instanceof LinkedAccountCallbackFailure) throw error;
    throw new LinkedAccountCallbackFailure(
      'provider_unavailable',
      error instanceof Error ? error.message : 'instance request failed',
    );
  } finally {
    if (token !== null) await revokeToken(host, registration, token);
    token = null;
  }
}
