/**
 * Federation Service
 *
 * Resolves fediverse (ActivityPub) handles to Oxy user profiles.
 * Handles WebFinger discovery, actor profile fetching, avatar download, and user upsert.
 * Signs outgoing requests with HTTP Signatures for servers that enforce authorized fetch.
 */

import crypto from 'crypto';
import type { IncomingMessage } from 'http';
import { and, eq, sql } from 'drizzle-orm';
import { signRequest, canonicalFederationHost } from '@oxyhq/federation';
import { safeFetch, SsrfRejection, type SafeFetchResult } from '@oxyhq/core/server';
import { getDb } from '../config/postgres';
import { federationKeyPairs } from '../db/schema/federationKeyPairs';
import { ACCOUNT_KINDS, users } from '../db/schema/users';
import { userService, type AccountDocument } from './user.service';
import { AssetService } from './assetService';
import { createS3Service } from './s3Service';
import { logger } from '../utils/logger';
import userCache from '../utils/userCache';
import { composeDisplayName } from '../utils/displayName';
import { cleanDisplayName } from '../utils/displayNameSanitize';
import { sanitizePlainText, decodeHtmlEntities } from '../utils/sanitize';

/** The `users.kind` closed value set, derived from the column itself. */
type AccountKind = (typeof ACCOUNT_KINDS)[number];

const AP_ACCEPT_TYPES = [
  'application/activity+json',
  'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
];

const AP_DOMAIN = process.env.FEDERATION_DOMAIN || 'oxy.so';
const USER_AGENT = 'OxyHQ/1.0 (ActivityPub)';

/**
 * Oxy's OWN federation apex domain(s). The fediverse treats `oxy.so` as a
 * remote ActivityPub origin, but it is in fact our own apex: a handle like
 * `nate@oxy.so` denotes the LOCAL user `nate`, NOT a remote actor. Resolving
 * such a handle must never WebFinger our own apex nor mint a `type:'federated'`
 * shadow row — that duplicates the real local user and shadows it in search.
 *
 * The set is the configured {@link AP_DOMAIN} plus any extra aliases supplied
 * via the optional comma-separated `FEDERATION_OWN_DOMAINS` env (e.g. a legacy
 * apex). Entries are trimmed, lowercased, and de-duplicated.
 *
 * This is the SINGLE source of truth for the own-domain set; consumers
 * (`routes/users.ts`, the dedupe script) import {@link isOwnFederationDomain}
 * or {@link OWN_FEDERATION_DOMAINS} from here rather than copying the constant.
 */
export const OWN_FEDERATION_DOMAINS: ReadonlySet<string> = new Set(
  [AP_DOMAIN, ...(process.env.FEDERATION_OWN_DOMAINS ?? '').split(',')]
    .map((domain) => canonicalFederationHost(domain))
    .filter((domain) => domain.length > 0),
);

/**
 * True when `domain` is one of Oxy's own federation domains (case-insensitive).
 * Strips a leading `www.` so `www.oxy.so` matches the apex entry.
 * Callers short-circuit resolution for own-domain handles (return null / reject
 * 400) so they never mint a `type:'federated'` shadow row.
 */
export function isOwnFederationDomain(domain: string): boolean {
  return OWN_FEDERATION_DOMAINS.has(canonicalFederationHost(domain));
}

/**
 * A cached federated record older than this is considered stale and triggers a
 * background refresh on the next resolve. The cached record is still returned
 * immediately — the refresh runs fire-and-forget. Bluesky-style: fast now,
 * eventually fresh.
 */
const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Minimum gap between background refresh attempts for the same actor. Guards
 * against refresh storms when many requests hit a stale record at once (each
 * request would otherwise schedule its own background fetch).
 */
const REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Minimum gap between forced avatar re-downloads for the same user. Even when a
 * caller passes `refresh: true` to PUT /users/resolve, we skip re-downloading
 * the avatar if it was fetched within this window. The persisted
 * `federation.lastAvatarFetchedAt` is the authority across restarts; the
 * in-memory {@link _lastAvatarAttemptAt} map coalesces bursts within a process.
 * 5 minutes matches {@link REFRESH_MIN_INTERVAL_MS} — a single avatar can't
 * meaningfully change faster than the actor record it belongs to.
 */
const AVATAR_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const FEDIVERSE_HANDLE_REGEX = /^@?[\w.-]+@[\w.-]+\.\w+$/;

/** Time-to-first-byte deadline for federation control-plane fetches (webfinger/actor). */
const FEDERATION_FETCH_TIMEOUT_MS = 10_000;
/** Time-to-first-byte deadline for avatar/media downloads. */
const FEDERATION_AVATAR_FETCH_TIMEOUT_MS = 15_000;
/** Hard cap on a remote avatar's body size (matches the historical 5MB limit). */
const FEDERATION_MAX_AVATAR_BYTES = 5 * 1024 * 1024;
/**
 * Hard cap on a federation JSON document (WebFinger JRD / ActivityPub actor).
 * Generous for legitimate actor objects, but bounds a hostile peer streaming an
 * unbounded body to exhaust memory.
 */
const FEDERATION_MAX_JSON_BYTES = 2 * 1024 * 1024;

/**
 * SSRF-safe federation fetch. All outbound federation traffic is funnelled here
 * so it inherits {@link safeFetch}'s DNS-pinned, redirect-revalidating,
 * private/metadata-IP denylisting protection (closing the DNS-rebind TOCTOU).
 * Restricted to https only — federation never legitimately targets http.
 *
 * Returns the validated, non-redirect {@link SafeFetchResult}, or `null` when the
 * URL is not https, is rejected by the SSRF guard, or the request fails. The
 * caller OWNS the returned `response` stream — read it via the bounded readers
 * below, which always destroy the stream.
 */
async function safeFederationFetch(
  rawUrl: string,
  options: { headers?: Record<string, string>; timeoutMs?: number; maxRedirects?: number } = {},
): Promise<SafeFetchResult | null> {
  let protocol: string;
  try {
    protocol = new URL(rawUrl).protocol;
  } catch {
    logger.warn(`Federation URL rejected: malformed ${rawUrl}`);
    return null;
  }
  if (protocol !== 'https:') {
    logger.warn(`Federation URL rejected: non-https protocol for ${rawUrl}`);
    return null;
  }

  try {
    return await safeFetch(rawUrl, {
      method: 'GET',
      headers: options.headers,
      headersTimeoutMs: options.timeoutMs ?? FEDERATION_FETCH_TIMEOUT_MS,
      signal: AbortSignal.timeout(options.timeoutMs ?? FEDERATION_FETCH_TIMEOUT_MS),
      maxRedirects: options.maxRedirects,
    });
  } catch (err) {
    if (err instanceof SsrfRejection) {
      logger.warn(`Federation URL rejected by SSRF guard (${err.message}): ${rawUrl}`);
      return null;
    }
    logger.warn(`Federation fetch failed for ${rawUrl}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Read an {@link IncomingMessage} body into a Buffer, aborting (and destroying
 * the stream) the moment it would exceed `maxBytes`. Returns `null` when the cap
 * is exceeded. The caller should short-circuit on the advertised
 * `content-length` (from the validated response headers) before calling this.
 */
function readBodyLimited(response: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise<Buffer | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (value: Buffer | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    response.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        response.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => finish(Buffer.concat(chunks, total)));
    response.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    response.on('close', () => finish(null));
  });
}

/**
 * Read a bounded JSON document from an {@link IncomingMessage}. Returns `null`
 * when the body exceeds {@link FEDERATION_MAX_JSON_BYTES} or is not valid JSON.
 */
async function readJsonLimited<T>(response: IncomingMessage): Promise<T | null> {
  const buffer = await readBodyLimited(response, FEDERATION_MAX_JSON_BYTES);
  if (!buffer || buffer.length === 0) return null;
  try {
    return JSON.parse(buffer.toString('utf-8')) as T;
  } catch {
    return null;
  }
}

// System user ID for federated avatar ownership
const FEDERATION_SYSTEM_USER = '__federation__';

function normalizeFediverseHandle(handle: string): string | null {
  const cleaned = handle.trim().replace(/^acct:/i, '').replace(/^@/, '');
  const atIndex = cleaned.indexOf('@');
  if (atIndex <= 0 || atIndex === cleaned.length - 1) return null;

  const localPart = cleaned.substring(0, atIndex).toLowerCase();
  const domain = cleaned.substring(atIndex + 1).toLowerCase();
  if (!localPart || !domain) return null;

  return `${localPart}@${domain}`;
}

function domainFromHandle(handle: string): string | null {
  const atIndex = handle.indexOf('@');
  if (atIndex === -1 || atIndex === handle.length - 1) return null;
  return handle.substring(atIndex + 1).toLowerCase();
}

/**
 * Actor URIs (or, when no actorUri is known yet, lowercased handles) currently
 * mid-refresh. Prevents two concurrent background refreshes of the same actor.
 */
const _refreshInFlight = new Set<string>();

/**
 * Last time a background refresh was *attempted* for a given key, used with
 * {@link REFRESH_MIN_INTERVAL_MS} to throttle repeated attempts.
 */
const _lastRefreshAttemptAt = new Map<string, number>();

/**
 * User ids whose avatar is currently mid-download via
 * {@link FederationService.scheduleAvatarRefresh}. Prevents two concurrent
 * background avatar downloads for the same user (e.g. a burst of PUT
 * /users/resolve calls).
 */
const _avatarRefreshInFlight = new Set<string>();

/**
 * Last time an avatar download was *attempted* for a given user id, used with
 * {@link AVATAR_REFRESH_MIN_INTERVAL_MS} to coalesce in-process bursts. The
 * persisted `federation.lastAvatarFetchedAt` remains the cross-restart authority.
 */
const _lastAvatarAttemptAt = new Map<string, number>();

/**
 * Check if a string looks like a fediverse handle (@user@domain or user@domain).
 */
export function isFediverseHandle(query: string): boolean {
  return FEDIVERSE_HANDLE_REGEX.test(query.trim());
}

// ============================================================
// HTTP Signature Signing
// ============================================================

/**
 * The three key-pair columns this service works in.
 *
 * `private_key_pem` is a PROTECTED column (`db/schema/protectedColumns.ts`), so
 * naming it here is a deliberate opt-in — this module is the only one that may
 * hold a private signing key, because it is the only one that signs. Every
 * other reader goes through {@link getPublicKeyForKeyId} / {@link getUserPublicKey},
 * which select the public half by name.
 */
const KEY_PAIR_COLUMNS = {
  keyId: federationKeyPairs.keyId,
  publicKeyPem: federationKeyPairs.publicKeyPem,
  privateKeyPem: federationKeyPairs.privateKeyPem,
} as const;

interface KeyPairDoc {
  keyId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

/** The public half of a key pair — safe to return over the wire. */
export interface PublicKeyDoc {
  keyId: string;
  publicKeyPem: string;
}

interface WebFingerResolution {
  actorUri: string;
  subjectAcct?: string;
}

const _keyPairCache = new Map<string, KeyPairDoc>();

/**
 * Compose the canonical `#main-key` keyId for a (username, domain) pair.
 *
 * The keyId is the single identity coordinate for a federation key: it embeds
 * BOTH the actor username and the serving domain, so a key minted for
 * `bob@mention.earth` (`https://mention.earth/ap/users/bob#main-key`) is
 * distinct from `bob` on oxy.so. The in-memory cache and the unique `keyId`
 * index in Mongo therefore enforce "one key pair per (username, domain)"
 * automatically — no separate compound field is required.
 */
function composeUserKeyId(username: string, domain: string): string {
  return `https://${domain}/ap/users/${username}#main-key`;
}

/** Compose the instance-actor keyId for a domain. */
function composeInstanceKeyId(domain: string): string {
  return `https://${domain}/ap/users/instance#main-key`;
}

/** Read one key pair by its keyId, or null when none exists. */
async function findKeyPair(keyId: string): Promise<KeyPairDoc | null> {
  const [row] = await getDb()
    .select(KEY_PAIR_COLUMNS)
    .from(federationKeyPairs)
    .where(eq(federationKeyPairs.keyId, keyId))
    .limit(1);
  return row ?? null;
}

/**
 * Get or create an RSA key pair for the given keyId.
 * Generated once per identity, stored in Postgres, cached in memory.
 *
 * The insert is `on conflict do nothing` on the unique `key_id` and falls back
 * to a read, which makes it genuinely idempotent under concurrency rather than
 * merely usually-idempotent: Mongo's read-then-create left a window in which
 * two simultaneous first signatures for the same actor both generated a key and
 * the second write failed the unique index outright. Here the loser simply
 * adopts the winner's key — which matters because the two would be DIFFERENT
 * keys, and a signature made with the one that lost verification against the
 * published public key would fail on the remote side.
 */
async function getOrCreateKeyPair(keyId: string): Promise<KeyPairDoc> {
  const cached = _keyPairCache.get(keyId);
  if (cached) return cached;

  const existing = await findKeyPair(keyId);
  if (existing) {
    _keyPairCache.set(keyId, existing);
    return existing;
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const [inserted] = await getDb()
    .insert(federationKeyPairs)
    .values({ keyId, publicKeyPem: publicKey, privateKeyPem: privateKey })
    .onConflictDoNothing({ target: federationKeyPairs.keyId })
    .returning(KEY_PAIR_COLUMNS);

  const result = inserted ?? (await findKeyPair(keyId));
  if (!result) {
    throw new Error(`Federation key pair for ${keyId} could not be created or resolved`);
  }
  _keyPairCache.set(keyId, result);
  return result;
}

/**
 * Get or create the instance-level key pair for a domain.
 * Defaults to Oxy's own federation domain ({@link AP_DOMAIN}) for backward
 * compatibility with Oxy's own instance actor and signed fetches.
 */
async function getInstanceKeyPair(domain: string = AP_DOMAIN): Promise<KeyPairDoc> {
  return getOrCreateKeyPair(composeInstanceKeyId(domain));
}

/**
 * Get or create a per-user key pair scoped to a domain.
 *
 * The key material is keyed by the full keyId (which embeds the domain), so a
 * single username maps to a DISTINCT key per domain. Defaults to Oxy's own
 * federation domain ({@link AP_DOMAIN}) for backward compatibility with Oxy's
 * own actor endpoints and managed accounts.
 */
export async function getUserKeyPair(username: string, domain: string = AP_DOMAIN): Promise<KeyPairDoc> {
  const normalizedUsername = username.trim().toLowerCase();
  return getOrCreateKeyPair(composeUserKeyId(normalizedUsername, domain));
}

/**
 * Return the PUBLIC half of an existing key pair for a keyId, or null if no key
 * pair exists for it. Never auto-creates and never exposes the private key —
 * used by the public-key endpoint and by callers that only need to publish a
 * `publicKey` block. To create a key on demand, use {@link getUserKeyPair} /
 * {@link getInstanceKeyPair}.
 */
export async function getPublicKeyForKeyId(keyId: string): Promise<PublicKeyDoc | null> {
  const cached = _keyPairCache.get(keyId);
  if (cached) {
    return { keyId: cached.keyId, publicKeyPem: cached.publicKeyPem };
  }

  const existing = await findKeyPair(keyId);
  if (!existing) return null;

  _keyPairCache.set(keyId, existing);
  return { keyId: existing.keyId, publicKeyPem: existing.publicKeyPem };
}

/**
 * Get or create the public half of a domain-scoped USER key pair.
 *
 * Used by the `/federation/public-key/:username` endpoint so Mention can
 * publish a spec-compliant `publicKey` block whose `id`/`owner` live on its own
 * domain — WITHOUT ever receiving the private key. Creation is intentional here:
 * the first publish of an actor mints its key, mirroring how Oxy's own actor
 * endpoints lazily create keys.
 */
export async function getUserPublicKey(username: string, domain: string = AP_DOMAIN): Promise<PublicKeyDoc> {
  const keyPair = await getUserKeyPair(username, domain);
  return { keyId: keyPair.keyId, publicKeyPem: keyPair.publicKeyPem };
}

/**
 * Sign an HTTP-Signature signing string with the private key identified by
 * `keyId`. The private key NEVER leaves this process — only the base64
 * signature is returned. The key pair MUST already exist (callers publish the
 * public key first via {@link getUserPublicKey} / the actor endpoints); this
 * does NOT auto-create a key, so a sign request for an unknown keyId returns
 * null and the route surfaces a 404.
 *
 * @returns The base64 RSA-SHA256 signature, or null if no key pair exists.
 */
export async function signWithKeyId(keyId: string, signingString: string): Promise<string | null> {
  const cached = _keyPairCache.get(keyId);
  let keyPair: KeyPairDoc | null = cached ?? null;

  if (!keyPair) {
    keyPair = await findKeyPair(keyId);
    if (keyPair) _keyPairCache.set(keyId, keyPair);
  }

  if (!keyPair) return null;

  const signer = crypto.createSign('sha256');
  signer.update(signingString);
  signer.end();
  return signer.sign(keyPair.privateKeyPem, 'base64');
}

/**
 * Fetch a URL with HTTP Signature authentication.
 * Required by servers that enforce authorized fetch (e.g., Threads).
 *
 * Follows redirects manually (bounded) and re-signs each hop — an HTTP
 * signature is bound to the `(request-target)` / `host` of one specific URL.
 * `safeFetch` cannot do this when it follows redirects internally.
 */
const SIGNED_FETCH_MAX_REDIRECTS = 3;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

async function signedFetch(url: string, accept: string): Promise<SafeFetchResult | null> {
  const keyPair = await getInstanceKeyPair();
  const signWithInstanceKey = async (_keyId: string, signingString: string): Promise<string> => {
    const signer = crypto.createSign('sha256');
    signer.update(signingString);
    signer.end();
    return signer.sign(keyPair.privateKeyPem, 'base64');
  };

  const fetchFollowingRedirects = async (initialUrl: string, signed: boolean): Promise<SafeFetchResult | null> => {
    let currentUrl = initialUrl;
    for (let hop = 0; hop <= SIGNED_FETCH_MAX_REDIRECTS; hop++) {
      const sigHeaders = signed
        ? await signRequest(signWithInstanceKey, keyPair.keyId, 'GET', currentUrl)
        : {};
      const res = await safeFederationFetch(currentUrl, {
        headers: {
          Accept: accept,
          'User-Agent': USER_AGENT,
          ...sigHeaders,
        },
        timeoutMs: FEDERATION_FETCH_TIMEOUT_MS,
        maxRedirects: 0,
      });
      if (!res) return null;
      if (!REDIRECT_STATUS_CODES.has(res.status)) {
        return res;
      }
      const location = res.headers.location;
      if (hop === SIGNED_FETCH_MAX_REDIRECTS || !location) {
        return res;
      }
      res.response.destroy();
      try {
        currentUrl = new URL(location, currentUrl).toString();
      } catch {
        return null;
      }
    }
    return null;
  };

  const res = await fetchFollowingRedirects(url, true);
  if (!res) return null;

  // Remote 5xx with a signature often means the server could not verify our keyId;
  // retry unsigned for public resources (same fallback as @oxyhq/federation/node).
  if (res.status >= 500) {
    logger.info(`[Federation] signedFetch got ${res.status} for ${url}, retrying unsigned`);
    res.response.destroy();
    return fetchFollowingRedirects(url, false);
  }

  if (res.status === 401 || res.status === 403) {
    logger.warn(
      `[Federation] signedFetch got ${res.status} for ${url} — remote rejected our HTTP signature`,
    );
  }

  return res;
}

/**
 * Inputs to {@link buildActor}. When `username` is null the actor is the
 * instance (`Application`) actor; otherwise it is a per-user (`Person`) actor.
 */
interface BuildActorOptions {
  domain: string;
  username: string | null;
  publicKeyPem: string;
  keyId: string;
  name: string;
  summary?: string;
  avatar?: string;
  /** Account graph kind → ActivityPub actor type (per-user actors only). */
  kind?: AccountKind;
}

/**
 * Map an account `kind` to its ActivityPub actor `type`. A personal account is a
 * `Person`; organizations/projects/bots/channels map to the corresponding AP
 * actor types so remote servers render them appropriately.
 *
 * A channel is a `Service`: a non-human publishing identity nobody logs into.
 * `Group` would be wrong — remote implementations that treat `Group` specially
 * read it as a community that re-broadcasts its members' posts, whereas a
 * channel publishes its own.
 */
function actorTypeForKind(kind: AccountKind | undefined): string {
  switch (kind) {
    case 'organization':
      return 'Organization';
    case 'project':
      return 'Group';
    case 'bot':
    case 'channel':
      return 'Service';
    default:
      return 'Person';
  }
}

/**
 * Single canonical builder for both the instance and per-user ActivityPub
 * actor documents. Every host-bearing field — `id`, `publicKey.id`,
 * `publicKey.owner`, `inbox`, `outbox`, `followers`, `following`, `url`, and
 * `endpoints.sharedInbox` — is derived from ONE `domain` argument so the actor
 * shape can never drift across a split set of hosts. Reducing the two actor
 * functions to this one builder is what guarantees a self-consistent actor.
 */
function buildActor(opts: BuildActorOptions): Record<string, unknown> {
  const { domain, username, publicKeyPem, keyId, name, summary, avatar, kind } = opts;
  const base = `https://${domain}/ap`;

  if (username === null) {
    const actorUrl = `${base}/users/instance`;
    return {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        'https://w3id.org/security/v1',
      ],
      id: actorUrl,
      type: 'Application',
      preferredUsername: 'instance',
      name,
      summary: summary ?? '',
      url: `https://${domain}`,
      inbox: `${actorUrl}/inbox`,
      outbox: `${actorUrl}/outbox`,
      endpoints: { sharedInbox: `${base}/inbox` },
      publicKey: {
        id: keyId,
        owner: actorUrl,
        publicKeyPem,
      },
    };
  }

  const actorUrl = `${base}/users/${username}`;
  return {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      'https://w3id.org/security/v1',
    ],
    id: actorUrl,
    type: actorTypeForKind(kind),
    preferredUsername: username,
    name,
    summary: summary ?? '',
    url: `https://${domain}/@${username}`,
    inbox: `${actorUrl}/inbox`,
    outbox: `${actorUrl}/outbox`,
    followers: `${actorUrl}/followers`,
    following: `${actorUrl}/following`,
    endpoints: { sharedInbox: `${base}/inbox` },
    icon: avatar ? {
      type: 'Image',
      mediaType: 'image/png',
      url: avatar,
    } : undefined,
    publicKey: {
      id: keyId,
      owner: actorUrl,
      publicKeyPem,
    },
  };
}

/**
 * Returns the instance actor JSON-LD document for HTTP Signature key
 * verification. Self-consistent on the given `domain` (defaults to Oxy's own
 * federation domain {@link AP_DOMAIN}).
 */
export async function getInstanceActor(domain: string = AP_DOMAIN): Promise<Record<string, unknown>> {
  const keyPair = await getInstanceKeyPair(domain);
  return buildActor({
    domain,
    username: null,
    publicKeyPem: keyPair.publicKeyPem,
    keyId: keyPair.keyId,
    name: domain,
  });
}

/**
 * Resolve a local user's avatar to a publicly-fetchable absolute URL for the
 * federated actor document's `icon`.
 *
 * - Already-absolute URLs (e.g. a remote avatar mirrored verbatim) pass through.
 * - A stored Oxy file id resolves to the public CDN URL of its `thumb` variant
 *   via the asset service, so remote servers fetch from `cloud.oxy.so` — never a
 *   raw S3 URL and never the previous broken `/files/<id>/variant/thumb` scheme.
 * - Anything that cannot be resolved publicly (missing/private avatar) is
 *   omitted rather than advertising an unreachable URL.
 */
async function resolveActorAvatarUrl(avatar: unknown): Promise<string | undefined> {
  if (typeof avatar !== 'string' || avatar.length === 0) {
    return undefined;
  }
  if (avatar.startsWith('http')) {
    return avatar;
  }

  try {
    const assetService = getAssetService();
    const file = await assetService.getFile(avatar);
    if (!file) {
      return undefined;
    }
    const cdnUrl = await assetService.getPublicCdnUrl(file, 'thumb');
    return cdnUrl ?? undefined;
  } catch (error) {
    logger.warn('Failed to resolve federated actor avatar URL', {
      avatar,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * The account fields an actor document is built from.
 *
 * A STRUCTURAL type rather than the whole account document: this is the entire
 * input to {@link buildActor}, so declaring it here is what lets `tsc` reject a
 * caller that hands over a row missing `kind` or `avatar` — which a
 * `Record<string, unknown>` parameter would have accepted silently.
 */
export interface ActorSourceUser {
  username?: string | null;
  name?: { first?: string | null; last?: string | null } | null;
  avatar?: string | null;
  bio?: string | null;
  description?: string | null;
  kind?: AccountKind | null;
}

/**
 * Returns a per-user actor JSON-LD document, self-consistent on `domain`
 * (defaults to Oxy's own federation domain {@link AP_DOMAIN}).
 *
 * The `name` field is the canonical composed display name (identity contract),
 * composed here via the shared {@link composeDisplayName} rules — the model
 * virtual it used to be read from does not exist on a row.
 */
export async function getUserActor(user: ActorSourceUser, domain: string = AP_DOMAIN): Promise<Record<string, unknown> | null> {
  if (!user?.username) return null;
  // Canonicalize before key lookup and actor URL assembly so `id`/`publicKey.owner`
  // always match `publicKey.id` (getUserKeyPair lowercases internally).
  const username = user.username.split('@')[0].trim().toLowerCase();
  const keyPair = await getUserKeyPair(username, domain);

  // An ActivityPub actor's `name` field requires a non-empty string. The API no
  // longer synthesizes a display name, so fall back to the handle (`username` is
  // guaranteed here — `getUserActor` returns null above when it is absent).
  const displayName = composeDisplayName({ name: user.name }) ?? username;

  const avatar = await resolveActorAvatarUrl(user.avatar);

  return buildActor({
    domain,
    username,
    publicKeyPem: keyPair.publicKeyPem,
    keyId: keyPair.keyId,
    name: displayName,
    summary: user.bio ?? user.description ?? '',
    avatar,
    // A row's `kind` is NOT NULL, but `ActorSourceUser` accepts null so a
    // caller reading through a nullable projection needs no laundering of its
    // own. `undefined` is what `actorTypeForKind` reads as "default to Person".
    kind: user.kind ?? undefined,
  });
}

// ============================================================
// Asset Service (lazy init)
// ============================================================

let _assetService: AssetService | null = null;

/**
 * Required env vars for federated avatar storage on S3.
 * These are validated at boot by `validateRequiredEnvVars()` in `config/env.ts`,
 * but we re-assert here so the failure mode is a loud throw at the call site
 * (with the relevant variable name) rather than an opaque AWS "missing credentials" error.
 */
function getAssetService(): AssetService {
  if (!_assetService) {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const bucketName = process.env.AWS_S3_BUCKET;

    if (!accessKeyId) {
      throw new Error('AWS_ACCESS_KEY_ID is required for the federation service');
    }
    if (!secretAccessKey) {
      throw new Error('AWS_SECRET_ACCESS_KEY is required for the federation service');
    }
    if (!bucketName) {
      throw new Error('AWS_S3_BUCKET is required for the federation service');
    }

    const s3 = createS3Service({
      region: process.env.AWS_REGION || 'us-east-1',
      accessKeyId,
      secretAccessKey,
      bucketName,
      endpointUrl: process.env.AWS_ENDPOINT_URL,
    });
    _assetService = new AssetService(s3);
  }
  return _assetService;
}

// ============================================================
// Federation Service
// ============================================================

class FederationService {
  private async storedAvatarExists(fileId: unknown): Promise<boolean> {
    if (typeof fileId !== 'string' || !fileId || fileId.startsWith('http')) {
      return false;
    }

    try {
      return await getAssetService().fileContentExists(fileId);
    } catch (err) {
      logger.warn(
        `Failed checking stored federated avatar ${fileId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Resolve a WebFinger acct to an ActivityPub actor URI.
   * @param acct - e.g. "alice@mastodon.social" or "@alice@mastodon.social"
   */
  async resolveWebFingerResource(acct: string): Promise<WebFingerResolution | null> {
    const normalizedAcct = normalizeFediverseHandle(acct);
    if (!normalizedAcct) return null;

    const domain = domainFromHandle(normalizedAcct);
    if (!domain) return null;

    const resource = `acct:${normalizedAcct}`;
    const url = `https://${domain}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`;

    try {
      const res = await safeFederationFetch(url, {
        headers: { Accept: 'application/jrd+json, application/json' },
        timeoutMs: FEDERATION_FETCH_TIMEOUT_MS,
      });
      if (!res || res.status < 200 || res.status >= 300) {
        res?.response.destroy();
        return null;
      }

      const data = await readJsonLimited<{
        subject?: string;
        links?: Array<{ rel?: string; type?: string; href?: string }>;
      }>(res.response);
      if (!data) return null;

      const link = data.links?.find(
        (l) => l.rel === 'self' && l.type && AP_ACCEPT_TYPES.includes(l.type),
      );
      if (!link?.href) return null;

      const subjectAcct = typeof data.subject === 'string'
        ? normalizeFediverseHandle(data.subject) || undefined
        : undefined;

      return {
        actorUri: link.href,
        subjectAcct,
      };
    } catch (err) {
      logger.warn(`WebFinger resolution failed for ${acct}: ${err}`);
      return null;
    }
  }

  /**
   * Resolve a WebFinger acct to an ActivityPub actor URI.
   * @param acct - e.g. "alice@mastodon.social" or "@alice@mastodon.social"
   */
  async resolveWebFinger(acct: string): Promise<string | null> {
    const resolution = await this.resolveWebFingerResource(acct);
    return resolution?.actorUri || null;
  }

  /**
   * Returns the acct that can be safely used as the canonical username for a
   * WebFinger result. A remote WebFinger endpoint may advertise `subject` as a
   * canonical alias (for example `user@www.example` -> `user@example`), but that
   * claimed account is controlled by a different domain. Before storing it,
   * resolve the claimed account through its own domain and require it to point
   * back to the same actor URI — otherwise an attacker domain could spoof an
   * identity on a trusted domain.
   */
  private async verifiedAccountForResolution(
    requestedAcct: string,
    resolution: WebFingerResolution,
  ): Promise<string> {
    const requested = normalizeFediverseHandle(requestedAcct);
    const subject = resolution.subjectAcct ? normalizeFediverseHandle(resolution.subjectAcct) : null;
    if (!requested || !subject || subject === requested) {
      return requested || requestedAcct.toLowerCase();
    }

    try {
      const subjectResolution = await this.resolveWebFingerResource(subject);
      if (subjectResolution?.actorUri === resolution.actorUri) {
        return subject;
      }

      logger.warn(
        `Ignoring unverified WebFinger subject ${subject} for ${requested}: `
          + `expected actor ${resolution.actorUri}, got ${subjectResolution?.actorUri || 'none'}`,
      );
    } catch (err) {
      logger.warn(
        `Failed verifying WebFinger subject ${subject} for ${requested}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return requested;
  }

  /**
   * Fetch an ActivityPub actor by URI and extract user-profile fields.
   * Uses HTTP Signature for servers that enforce authorized fetch.
   */
  async fetchActorProfile(actorUri: string, acctHint?: string): Promise<{
    actorUri: string;
    domain: string;
    username: string;
    displayName: string;
    avatarUrl?: string;
    bio?: string;
  } | null> {
    try {
      const res = await signedFetch(actorUri, AP_ACCEPT_TYPES[0]);
      if (!res || res.status < 200 || res.status >= 300) {
        res?.response.destroy();
        return null;
      }

      const actor = await readJsonLimited<Record<string, unknown>>(res.response);
      if (!actor || typeof actor.id !== 'string' || !actor.inbox) return null;

      // The actor's `id` is attacker-controlled by the actor host; it must be a
      // public https URL before we trust its host as the canonical domain.
      let actorHost: string;
      try {
        const actorIdUrl = new URL(actor.id);
        if (actorIdUrl.protocol !== 'https:') return null;
        actorHost = actorIdUrl.hostname.toLowerCase();
      } catch {
        return null;
      }
      const username = (actor.preferredUsername as string) || (actor.name as string) || 'unknown';
      const actorWebfinger = typeof actor.webfinger === 'string'
        ? normalizeFediverseHandle(actor.webfinger)
        : null;
      const hintedAcct = acctHint ? normalizeFediverseHandle(acctHint) : null;
      // The handle used for storage must come from the WebFinger resource we
      // resolved and verified before fetching this actor. Actor documents are
      // attacker-controlled by the actor host, so their optional `webfinger`
      // field is only a fallback when no trusted hint is available.
      const acct = hintedAcct || actorWebfinger || `${username.toLowerCase()}@${actorHost}`;
      const domain = domainFromHandle(acct) || actorHost;

      return {
        actorUri: actor.id,
        domain,
        username: acct,
        displayName: decodeHtmlEntities((actor.name as string) || username),
        avatarUrl: (actor.icon as Record<string, unknown>)?.url as string | undefined,
        bio: decodeHtmlEntities((actor.summary as string)?.replace(/<[^>]*>/g, '') || ''),
      };
    } catch (err) {
      logger.warn(`Failed to fetch actor profile ${actorUri}: ${err}`);
      return null;
    }
  }

  /**
   * Download a remote avatar image, upload it to Oxy Cloud, and return the file
   * ID along with the validators the host advertised.
   *
   * Conditional requests: when `conditional.etag` / `conditional.lastModified`
   * are supplied (from a previous fetch), they are replayed as `If-None-Match` /
   * `If-Modified-Since`. A `304 Not Modified` response means the stored file is
   * still current — we skip the download+upload round-trip entirely and signal
   * `notModified: true` so the caller can still advance its throttle clock.
   *
   * If the user already has an avatar file, the old one is deleted before the
   * new upload (only when we actually downloaded a new image).
   *
   * @param avatarUrl              - Remote avatar URL to fetch.
   * @param existingAvatarFileId   - Current stored file id (deleted on replace).
   * @param conditional            - Stored validators to replay as conditional headers.
   */
  async downloadAndStoreAvatar(
    avatarUrl: string,
    existingAvatarFileId?: string,
    conditional?: { etag?: string; lastModified?: string },
    ownerUserId = FEDERATION_SYSTEM_USER,
  ): Promise<{ fileId: string | null; etag?: string; lastModified?: string; notModified: boolean }> {
    try {
      const requestHeaders: Record<string, string> = { 'User-Agent': USER_AGENT };
      if (conditional?.etag) {
        requestHeaders['If-None-Match'] = conditional.etag;
      }
      if (conditional?.lastModified) {
        requestHeaders['If-Modified-Since'] = conditional.lastModified;
      }

      const res = await safeFederationFetch(avatarUrl, {
        headers: requestHeaders,
        timeoutMs: FEDERATION_AVATAR_FETCH_TIMEOUT_MS,
      });
      if (!res) {
        return { fileId: null, notModified: false };
      }

      // 304: the host confirms the remote bytes are unchanged. This only means
      // our local copy is usable if the referenced asset still exists in S3.
      // If the DB record points to a missing object, retry without validators
      // so the remote sends the body and we can repair the stored file id.
      if (res.status === 304) {
        res.response.destroy();
        if (await this.storedAvatarExists(existingAvatarFileId)) {
          return {
            fileId: null,
            etag: conditional?.etag,
            lastModified: conditional?.lastModified,
            notModified: true,
          };
        }

        logger.warn(`Remote avatar returned 304 but stored file is missing for ${avatarUrl}; retrying full download`);
        if (conditional?.etag || conditional?.lastModified) {
          return this.downloadAndStoreAvatar(avatarUrl, existingAvatarFileId, undefined, ownerUserId);
        }

        return {
          fileId: null,
          etag: conditional?.etag,
          lastModified: conditional?.lastModified,
          notModified: false,
        };
      }

      if (res.status < 200 || res.status >= 300) {
        res.response.destroy();
        logger.warn(`Avatar download failed: HTTP ${res.status} for ${avatarUrl}`);
        return { fileId: null, notModified: false };
      }

      const headerValue = (name: string): string | undefined => {
        const value = res.headers[name];
        return Array.isArray(value) ? value[0] : value || undefined;
      };
      const etag = headerValue('etag');
      const lastModified = headerValue('last-modified');

      // Sanitize content-type: strip parameters (e.g. "image/jpeg; charset=utf-8" → "image/jpeg")
      const rawContentType = headerValue('content-type') || 'image/png';
      const contentType = rawContentType.split(';')[0].trim().toLowerCase();

      // Accept image/* and common binary types that CDNs return for images
      if (!contentType.startsWith('image/') && contentType !== 'application/octet-stream') {
        res.response.destroy();
        logger.warn(`Avatar download skipped: non-image content-type "${rawContentType}" for ${avatarUrl}`);
        return { fileId: null, etag, lastModified, notModified: false };
      }

      // Enforce a hard byte cap; safeFetch does NOT bound the response body. A
      // pre-check on the advertised content-length drops an oversized body
      // before reading a single byte, and the streaming reader caps anything
      // the header understated. An oversized body returns null and is dropped.
      const advertisedLength = headerValue('content-length');
      if (advertisedLength !== undefined && Number(advertisedLength) > FEDERATION_MAX_AVATAR_BYTES) {
        res.response.destroy();
        logger.warn(`Avatar download skipped: content-length ${advertisedLength} exceeds cap for ${avatarUrl}`);
        return { fileId: null, etag, lastModified, notModified: false };
      }

      const buffer = await readBodyLimited(res.response, FEDERATION_MAX_AVATAR_BYTES);
      if (!buffer || buffer.length === 0) {
        return { fileId: null, etag, lastModified, notModified: false };
      }

      // For application/octet-stream, infer MIME from URL extension or default to png
      let mime = contentType;
      if (mime === 'application/octet-stream') {
        const urlLower = avatarUrl.toLowerCase();
        if (urlLower.endsWith('.jpg') || urlLower.endsWith('.jpeg')) mime = 'image/jpeg';
        else if (urlLower.endsWith('.webp')) mime = 'image/webp';
        else if (urlLower.endsWith('.gif')) mime = 'image/gif';
        else mime = 'image/png';
      }

      const assetService = getAssetService();

      // Determine extension from sanitized content type
      const extMap: Record<string, string> = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif',
      };
      const ext = extMap[mime] || 'png';
      const filename = `federated-avatar-${crypto.randomBytes(8).toString('hex')}.${ext}`;

      const file = await assetService.uploadFileDirect(
        ownerUserId,
        buffer,
        mime,
        filename,
        'public',
        {
          source: 'federation',
          role: 'avatar',
          remoteUrl: avatarUrl,
        },
      );

      const fileId = file.id;

      // Delete the replaced avatar only after the new durable file is present.
      // If dedupe returned the same file, keep it.
      if (
        existingAvatarFileId &&
        !existingAvatarFileId.startsWith('http') &&
        existingAvatarFileId !== fileId
      ) {
        try {
          await assetService.deleteFile(existingAvatarFileId, true);
        } catch {
          // Old file may already be gone — not critical
        }
      }

      return { fileId, etag, lastModified, notModified: false };
    } catch (err) {
      logger.warn(`Failed to download/store federated avatar: ${err}`);
      return { fileId: null, notModified: false };
    }
  }

  /**
   * Full pipeline: resolve a fediverse handle to an Oxy user.
   *
   * Fast + eventually-fresh (Bluesky-style):
   * 1. If a cached federated user exists, RETURN IT IMMEDIATELY — never block
   *    on remote I/O when we already have a row. If that row is stale (older
   *    than {@link STALE_MS}) or still has a raw-URL avatar that needs
   *    downloading, kick off a fire-and-forget background refresh that replaces
   *    avatar/name/bio in place, but still return the cached record now.
   * 2. If NO cached row exists, do the first-time blocking fetch:
   *    WebFinger → fetch actor profile (HTTP Signature) → download avatar →
   *    upsert as type=federated → return.
   */
  /**
   * Hand back a cached federated row without blocking on remote I/O. Schedules a
   * background refresh when the record is stale or its avatar still needs work.
   */
  private async returnCachedFederatedRow(
    existing: AccountDocument,
    handleForRefresh: string,
  ): Promise<AccountDocument> {
    // Archived actors (410-Gone tombstones) stay cached for follow-graph /
    // audit continuity but must not be refreshed or re-surfaced as live.
    if (existing.accountStatus === 'archived') {
      return existing;
    }

    const updatedAt = existing.updatedAt;
    const isStale = !(updatedAt instanceof Date)
      || Date.now() - updatedAt.getTime() >= STALE_MS;
    const avatarNeedsDownload = typeof existing.avatar === 'string'
      && existing.avatar.startsWith('http');
    const avatarFileMissing = !isStale && !avatarNeedsDownload
      ? !(await this.storedAvatarExists(existing.avatar))
      : false;

    if (isStale || avatarNeedsDownload || avatarFileMissing) {
      this.scheduleBackgroundRefresh(existing, handleForRefresh);
    }

    return existing;
  }

  async resolveAndUpsert(handle: string): Promise<AccountDocument | null> {
    const cleaned = normalizeFediverseHandle(handle);
    if (!cleaned) return null;

    const domain = domainFromHandle(cleaned);
    if (!domain) return null;

    // Own-domain guard: a handle like `nate@oxy.so` is a NON-ENTITY. On Oxy's
    // own apex the only valid identity is the bare local handle `@nate`; the
    // domain-qualified form `@nate@oxy.so` must never resolve or be surfaced, so
    // it can't even look like a second representation of the same user. Return
    // null immediately — never WebFinger our own apex, never touch the DB, and
    // never upsert a `type:'federated'` shadow row.
    if (isOwnFederationDomain(domain)) {
      return null;
    }

    // Check cache: existing federated user.
    //
    // Fediverse usernames are case-insensitive and we store them lowercased,
    // but the lookup is written against the EXPRESSION `users_username_key` is
    // built on (`lower(btrim(username))`) rather than a plain equality: a
    // correct-looking `username = $1` is case-SENSITIVE and would miss a row
    // whose stored casing differs, then upsert a duplicate actor beside it.
    const cleanedHandle = cleaned.toLowerCase();
    const [existingRow] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.type, 'federated'),
          eq(users.federationDomain, domain),
          sql`lower(btrim(${users.username})) = lower(btrim(${cleanedHandle}))`
        )
      )
      .limit(1);

    // The row is re-read as the full account document so the shape this service
    // returns is byte-identical to what `PUT /users/resolve` returns for the
    // same actor — one serializer, not two.
    const existing = existingRow ? await userService.readAccountDocument(existingRow.id) : null;

    if (existing) {
      return this.returnCachedFederatedRow(existing, cleaned);
    }

    // No cached row — first-time blocking fetch (the only allowed blocking case).
    const webfinger = await this.resolveWebFingerResource(cleaned);
    if (!webfinger) return null;

    // A relabelled bridge identity (e.g. `wired@x.com` stored via
    // `PUT /users/resolve`) shares the bridge actor URI but not the bridge
    // handle. A lookup keyed only on `(federationDomain, username)` would miss
    // it and the upsert below would clobber the relabelled username/domain.
    const [existingByActorUriRow] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.type, 'federated'),
          eq(users.federationActorUri, webfinger.actorUri),
        ),
      )
      .limit(1);

    const existingByActorUri = existingByActorUriRow
      ? await userService.readAccountDocument(existingByActorUriRow.id)
      : null;

    // The actor URI is the stable identity key. Never let a different
    // WebFinger resource relabel an existing actor: a malicious domain can
    // point its self link at any known actor URI, while the upsert below keys on
    // that URI and would otherwise overwrite the victim's username/domain.
    // This also preserves intentionally relabelled bridge identities.
    if (existingByActorUri) {
      return this.returnCachedFederatedRow(existingByActorUri, cleaned);
    }

    const verifiedAcct = await this.verifiedAccountForResolution(cleaned, webfinger);
    const profile = await this.fetchActorProfile(webfinger.actorUri, verifiedAcct);
    if (!profile) return null;

    // COLUMN PROPERTIES, never Mongo dot paths. Drizzle keys `set()`/`values()`
    // by column property and SILENTLY IGNORES an unknown key, so `'name.first'`
    // here would write nothing and throw nothing — the exact failure that left
    // every federated actor resolved through `PUT /users/resolve` with a null
    // display name until it was caught there.
    const setFields: Partial<typeof users.$inferInsert> = {
      username: profile.username,
      nameFirst: cleanDisplayName(profile.displayName),
      federationActorUri: profile.actorUri,
      federationDomain: profile.domain,
      federationLastResolvedAt: new Date(),
      // Mongo's `$unset` of the tombstone fields. NULL is what "available"
      // means on these two columns, so clearing them is a write of NULL.
      federationUnavailableAt: null,
      federationUnavailableReason: null,
    };

    if (typeof profile.bio === 'string') {
      const safeBio = sanitizePlainText(profile.bio);
      setFields.bio = safeBio;
      setFields.description = safeBio;
    }

    // Mongo's `{upsert: true}` on the unique `federation.actorUri`. `type` is
    // written only on INSERT — matching `PUT /users/resolve`, where re-writing
    // it on update would let the federation pipeline silently re-type an
    // existing account. Column DEFAULTs replace `setDefaultsOnInsert`.
    const [upserted] = await getDb()
      .insert(users)
      .values({ ...setFields, type: 'federated' })
      .onConflictDoUpdate({ target: users.federationActorUri, set: setFields })
      .returning({ id: users.id });

    if (!upserted) {
      return null;
    }

    const userId = upserted.id;
    logger.info(`Resolved fediverse user: ${profile.username} (${profile.actorUri})`);
    userCache.invalidate(userId);

    if (profile.avatarUrl) {
      const stored = await this.downloadAndStoreAvatar(
        profile.avatarUrl,
        undefined,
        undefined,
        userId,
      );
      if (stored.fileId) {
        const avatarFields: Partial<typeof users.$inferInsert> = {
          avatar: stored.fileId,
          federationLastAvatarFetchedAt: new Date(),
        };
        if (stored.etag) avatarFields.federationAvatarETag = stored.etag;
        if (stored.lastModified) avatarFields.federationAvatarLastModified = stored.lastModified;

        await getDb().update(users).set(avatarFields).where(eq(users.id, userId));
        userCache.invalidate(userId);
      }
    }

    // Read the row back rather than patching the returned document field by
    // field as Mongo did: the avatar write above happens AFTER the upsert, and
    // hand-mirroring it into an in-memory copy is how the returned document and
    // the stored row drift.
    return userService.readAccountDocument(userId);
  }

  /**
   * Fire-and-forget scheduler for {@link refreshFederatedUser}.
   *
   * Storm guard: a given actor is refreshed at most once concurrently
   * ({@link _refreshInFlight}) and at most once per {@link REFRESH_MIN_INTERVAL_MS}
   * ({@link _lastRefreshAttemptAt}). The refresh key is the actor URI when known,
   * otherwise the lowercased handle. This method NEVER awaits and NEVER throws —
   * a rejected refresh is caught and logged so it can't surface as an unhandled
   * rejection or crash the process.
   */
  private scheduleBackgroundRefresh(existing: AccountDocument, handle: string): void {
    if (existing.accountStatus === 'archived') {
      return;
    }

    const key = existing.federation.actorUri || handle.toLowerCase();

    if (_refreshInFlight.has(key)) return;

    const lastAttempt = _lastRefreshAttemptAt.get(key);
    if (lastAttempt !== undefined && Date.now() - lastAttempt < REFRESH_MIN_INTERVAL_MS) {
      return;
    }

    _refreshInFlight.add(key);
    _lastRefreshAttemptAt.set(key, Date.now());

    void this.refreshFederatedUser(existing, handle)
      .catch((err) => {
        logger.warn(
          `Background federated refresh failed for ${key}: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        _refreshInFlight.delete(key);
      });
  }

  /**
   * Fire-and-forget scheduler that moves a remote avatar download OFF the
   * request path (used by PUT /users/resolve). The caller upserts the user and
   * returns immediately; this replaces the user's `avatar` file id once the
   * download completes and invalidates the user cache.
   *
   * Throttle: at most one download per user concurrently
   * ({@link _avatarRefreshInFlight}) and at most one per
   * {@link AVATAR_REFRESH_MIN_INTERVAL_MS} per process
   * ({@link _lastAvatarAttemptAt}). The persisted
   * `federation.lastAvatarFetchedAt`, re-read inside {@link downloadAvatarForUser},
   * is the cross-restart authority. This method NEVER awaits and NEVER throws —
   * a rejection is caught and logged so it can't surface as an unhandled
   * rejection.
   *
   * @param userId               - The upserted user's id (resolved fresh inside).
   * @param remoteAvatarUrl      - The http(s) avatar URL to download.
   * @param existingAvatarFileId - Current stored avatar file id (deleted on replace).
   * @param opts.force           - When true (a `refresh`/`forceAvatarRefresh`
   *                               request), re-download even if a stored file id
   *                               already exists — still subject to the throttle.
   */
  scheduleAvatarRefresh(
    userId: string,
    remoteAvatarUrl: string,
    existingAvatarFileId: string | undefined,
    opts: { force: boolean },
  ): void {
    if (_avatarRefreshInFlight.has(userId)) return;

    const lastAttempt = _lastAvatarAttemptAt.get(userId);
    if (lastAttempt !== undefined && Date.now() - lastAttempt < AVATAR_REFRESH_MIN_INTERVAL_MS) {
      return;
    }

    _avatarRefreshInFlight.add(userId);
    _lastAvatarAttemptAt.set(userId, Date.now());

    void this.downloadAvatarForUser(userId, remoteAvatarUrl, existingAvatarFileId, opts)
      .catch((err) => {
        logger.warn(
          `Background avatar refresh failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        _avatarRefreshInFlight.delete(userId);
      });
  }

  /**
   * Background worker for {@link scheduleAvatarRefresh}. Resolves the user fresh
   * from its id so it reads the authoritative persisted throttle clock and
   * conditional-request validators, downloads the avatar (conditionally), and
   * persists the result. Wraps its whole body so a rejection can never escape
   * the fire-and-forget caller — all failures are logged.
   */
  private async downloadAvatarForUser(
    userId: string,
    remoteAvatarUrl: string,
    existingAvatarFileId: string | undefined,
    opts: { force: boolean },
  ): Promise<void> {
    try {
      // Four named columns, not `select()`: `users` carries protected columns
      // (the raw phone number, the contact-discovery hashes, the refresh
      // token) that a background avatar worker has no business loading.
      const [user] = await getDb()
        .select({
          avatar: users.avatar,
          lastAvatarFetchedAt: users.federationLastAvatarFetchedAt,
          avatarETag: users.federationAvatarETag,
          avatarLastModified: users.federationAvatarLastModified,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) {
        logger.warn(`Background avatar refresh: user ${userId} not found`);
        return;
      }

      const storedAvatar = typeof user.avatar === 'string' ? user.avatar : existingAvatarFileId;
      const alreadyHasFileId = typeof storedAvatar === 'string'
        && storedAvatar.length > 0
        && !storedAvatar.startsWith('http');

      // Persisted authority: skip a forced re-download inside the throttle window.
      // The in-memory guard in scheduleAvatarRefresh handles the common in-process
      // burst; this catches forced refreshes across process restarts.
      const lastFetched = user.lastAvatarFetchedAt;
      if (
        opts.force
        && alreadyHasFileId
        && lastFetched
        && Date.now() - lastFetched.getTime() < AVATAR_REFRESH_MIN_INTERVAL_MS
      ) {
        return;
      }

      // Without a force flag, never re-download once we hold a stored file id.
      if (!opts.force && alreadyHasFileId) {
        return;
      }

      const stored = await this.downloadAndStoreAvatar(remoteAvatarUrl, storedAvatar, {
        // The conditional-request validators are NULL when never fetched;
        // `downloadAndStoreAvatar` reads them as "send no If-None-Match", which
        // is what absent meant in Mongo.
        etag: user.avatarETag ?? undefined,
        lastModified: user.avatarLastModified ?? undefined,
      }, userId);

      const setFields: Partial<typeof users.$inferInsert> = {
        federationLastAvatarFetchedAt: new Date(),
      };

      if (stored.notModified) {
        // Host says our copy is current — only advance the fetch clock.
        await getDb().update(users).set(setFields).where(eq(users.id, userId));
        userCache.invalidate(userId);
        return;
      }

      if (!stored.fileId) {
        // Download failed — keep the existing avatar, but advance the clock so a
        // forced refresh can't hammer a broken remote every request.
        await getDb().update(users).set(setFields).where(eq(users.id, userId));
        userCache.invalidate(userId);
        logger.warn(`Background avatar refresh: download failed for ${userId} (keeping existing)`);
        return;
      }

      setFields.avatar = stored.fileId;
      if (stored.etag) setFields.federationAvatarETag = stored.etag;
      if (stored.lastModified) setFields.federationAvatarLastModified = stored.lastModified;

      await getDb().update(users).set(setFields).where(eq(users.id, userId));

      // CRITICAL: every path that mutates user state must invalidate the cache,
      // otherwise getUserBySession serves stale in-memory data and silently
      // reverts this update.
      userCache.invalidate(userId);

      logger.info(`Background-refreshed federated avatar for ${userId}`);
    } catch (err) {
      // Defensive: this worker must never throw out of the fire-and-forget
      // caller. The scheduler also has a .catch, but we log here with context too.
      logger.error(
        `Background avatar refresh threw for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Re-fetch a federated actor's avatar/name/bio and update the cached Oxy user
   * in place. Runs in the background (fire-and-forget). Wraps its whole body so
   * a rejection can never escape the caller — all failures are logged.
   *
   * @param existing - The cached federated user to refresh.
   * @param handle   - The lowercased handle, used to re-WebFinger if no actorUri.
   */
  private async refreshFederatedUser(existing: AccountDocument, handle: string): Promise<void> {
    if (existing.accountStatus === 'archived') {
      return;
    }

    const userId = existing._id;
    try {
      // Resolve the actor URI: reuse the stored one, else re-WebFinger.
      const actorUri = existing.federation.actorUri
        || await this.resolveWebFinger(handle);
      if (!actorUri) {
        logger.warn(`Background refresh: could not resolve actor URI for ${handle}`);
        return;
      }

      const profile = await this.fetchActorProfile(actorUri, handle);
      if (!profile) {
        logger.warn(`Background refresh: actor profile fetch returned null for ${actorUri}`);
        return;
      }

      // COLUMN PROPERTIES, never Mongo dot paths — see the note in
      // `resolveAndUpsert`. `name.first` here would silently write nothing.
      const setFields: Partial<typeof users.$inferInsert> = {};

      if (profile.displayName) {
        setFields.nameFirst = cleanDisplayName(profile.displayName);
      }
      setFields.federationLastResolvedAt = new Date();
      if (typeof profile.bio === 'string') {
        const safeBio = sanitizePlainText(profile.bio);
        setFields.bio = safeBio;
        setFields.description = safeBio;
      }

      // Download the latest avatar and replace the old stored file, replaying any
      // stored validators as a conditional request. Only set the avatar field
      // when the download succeeded — never clobber a good avatar with null
      // because the remote fetch failed. On 304 we keep the existing file but
      // still advance the fetch clock so we don't re-attempt every request.
      if (profile.avatarUrl) {
        const existingAvatar = typeof existing.avatar === 'string' ? existing.avatar : undefined;
        // The conditional-request validators are read from the ROW, not from
        // the account document this worker was handed. `AccountDocument`'s
        // `federation` key carries only `actorUri`/`domain` (it is the wire
        // shape `PUT /users/resolve` returns), so reading `avatarETag` off it
        // would compile — through the index signature — and be `undefined`
        // forever, quietly turning every background refresh into an
        // unconditional re-download of an unchanged image.
        const [validators] = await getDb()
          .select({
            etag: users.federationAvatarETag,
            lastModified: users.federationAvatarLastModified,
          })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        const stored = await this.downloadAndStoreAvatar(profile.avatarUrl, existingAvatar, {
          etag: validators?.etag ?? undefined,
          lastModified: validators?.lastModified ?? undefined,
        }, userId);
        if (stored.notModified) {
          setFields.federationLastAvatarFetchedAt = new Date();
        } else if (stored.fileId) {
          setFields.avatar = stored.fileId;
          setFields.federationLastAvatarFetchedAt = new Date();
          if (stored.etag) setFields.federationAvatarETag = stored.etag;
          if (stored.lastModified) setFields.federationAvatarLastModified = stored.lastModified;
        } else {
          logger.warn(`Background refresh: avatar download failed for ${actorUri} (keeping existing)`);
        }
      }

      // `federationLastResolvedAt` is set unconditionally above, so `setFields`
      // is never empty — the Mongo branch that touched `updatedAt` alone to
      // avoid re-attempting every request is unreachable here and is gone
      // rather than kept as dead code. `updated_at` is maintained by drizzle's
      // `$onUpdate` on the write below, which is what that branch was for.
      await getDb()
        .update(users)
        .set({
          ...setFields,
          // Mongo's `$unset` of the tombstone fields — NULL is "available".
          federationUnavailableAt: null,
          federationUnavailableReason: null,
        })
        .where(eq(users.id, userId));

      // CRITICAL: every path that mutates user state must invalidate the cache,
      // otherwise getUserBySession serves stale in-memory data and silently
      // reverts this update.
      userCache.invalidate(userId);

      logger.info(
        `Background-refreshed federated user ${existing.username || handle} (${actorUri})`,
      );
    } catch (err) {
      // Defensive: refreshFederatedUser must never throw out of the
      // fire-and-forget caller. The scheduler also has a .catch, but we log here
      // with full context too.
      logger.error(
        `Background refresh threw for ${handle} (${userId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const federationService = new FederationService();
export default federationService;
