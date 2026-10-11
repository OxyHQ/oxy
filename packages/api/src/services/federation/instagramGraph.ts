/**
 * Meta Graph API Business Discovery: a read-only fallback transport for
 * Business/Creator Instagram accounts when the kilogram.makeup ActivityPub
 * bridge is unavailable (it answers 429 to WebFinger routinely).
 *
 * Runs whenever a token AND a numeric business account id are configured, and
 * is fully inert without them. Every failure is `null` to the
 * caller with one structured log line; the access token is sent only in the
 * `Authorization` header and never logged.
 *
 * The IG User id Business Discovery returns is the same value the first-party
 * profile proof pins as `instagramGraphId`, which is what lets a Graph source
 * join an already-pinned Instagram identity (see the registry).
 */
import type { IncomingMessage } from 'http';
import { safeFetch, SsrfRejection } from '@oxy.so/core/server';
import { federatedUsernameFromUpstreamUrl } from '@oxy.so/federation';
import { logger } from '../../utils/logger';
import { sanitizePlainText } from '../../utils/sanitize';
import { normalizeExternalBio, type ExternalActorProfile } from './externalIdentityPolicy';

export const INSTAGRAM_GRAPH_PROTOCOL = 'instagram-graph';
export const INSTAGRAM_GRAPH_ACTOR_PREFIX = `${INSTAGRAM_GRAPH_PROTOCOL}:`;
export const INSTAGRAM_NETWORK_DOMAIN = 'instagram.com';

/** Pinned in code: a Graph version bump is a reviewed change, never an env knob. */
const GRAPH_API_VERSION = 'v23.0';
const GRAPH_FETCH_TIMEOUT_MS = 10_000;
const GRAPH_MAX_JSON_BYTES = 256 * 1024;
/** Business Discovery allows ~200 calls/hour per token: cache both outcomes briefly. */
const RESULT_CACHE_TTL_MS = 10 * 60_000;
const RESULT_CACHE_MAX_ENTRIES = 1_000;
/** After a throttle answer (or usage above the threshold) stop calling Meta for a while. */
const THROTTLE_COOLDOWN_MS = 15 * 60_000;
const APP_USAGE_COOLDOWN_PERCENT = 90;
/** Meta error codes meaning "slow down": app, user, page and custom-rate throttles. */
const THROTTLE_ERROR_CODES = new Set([4, 17, 32, 613, 80001, 80002]);
const TOKEN_ERROR_CODE = 190;
const NOT_A_BUSINESS_ACCOUNT_SUBCODE = 2207013;
const INSTAGRAM_USERNAME = /^[a-z0-9._]{1,30}$/;
const GRAPH_USER_ID = /^[0-9]{1,32}$/;

export type InstagramGraphFailureReason =
  | 'not_configured'
  | 'invalid_username'
  | 'not_found'
  | 'throttled'
  | 'token_invalid'
  | 'http_status'
  | 'transport_unavailable'
  | 'unreadable_document'
  | 'identity_mismatch';
export type InstagramGraphLookup =
  | { ok: true; profile: ExternalActorProfile; igUserId: string }
  | { ok: false; reason: InstagramGraphFailureReason };

interface GraphConfig {
  token: string;
  businessAccountId: string;
}

/** Read per call so a credential rotation (or a test) needs no process restart. */
export function instagramGraphConfig(): GraphConfig | null {
  const token = (process.env.META_GRAPH_ACCESS_TOKEN ?? '').trim();
  const businessAccountId = (process.env.META_IG_BUSINESS_ACCOUNT_ID ?? '').trim();
  if (!token || !GRAPH_USER_ID.test(businessAccountId)) return null;
  return { token, businessAccountId };
}

export function isInstagramGraphConfigured(): boolean {
  return instagramGraphConfig() !== null;
}

export function instagramGraphActorUri(igUserId: string): string {
  return `${INSTAGRAM_GRAPH_ACTOR_PREFIX}${igUserId}`;
}

export function isInstagramGraphActorUri(actorUri: string): boolean {
  return actorUri.startsWith(INSTAGRAM_GRAPH_ACTOR_PREFIX);
}

/** The IG User id of a well-formed Graph actor URI, else null. */
export function instagramGraphUserIdFromActorUri(actorUri: string): string | null {
  if (!isInstagramGraphActorUri(actorUri)) return null;
  const id = actorUri.slice(INSTAGRAM_GRAPH_ACTOR_PREFIX.length);
  return GRAPH_USER_ID.test(id) ? id : null;
}

/** `alice@instagram.com` / `alice` → `alice`, or null when it is not an Instagram username. */
export function instagramUsernameFromAcct(acct: string): string | null {
  const cleaned = acct.trim().replace(/^@/, '').toLowerCase();
  const at = cleaned.lastIndexOf('@');
  if (at !== -1 && cleaned.slice(at + 1) !== INSTAGRAM_NETWORK_DOMAIN) return null;
  const local = at === -1 ? cleaned : cleaned.slice(0, at);
  return INSTAGRAM_USERNAME.test(local) ? local : null;
}

/** A handle or instagram.com profile URL naming an Instagram account → `<username>@instagram.com`. */
export function instagramAcctFromHandle(value: string): string | null {
  const acct = (federatedUsernameFromUpstreamUrl(value) ?? value)
    .trim()
    .replace(/^acct:/i, '')
    .replace(/^@/, '')
    .toLowerCase();
  if (!acct.endsWith(`@${INSTAGRAM_NETWORK_DOMAIN}`)) return null;
  const username = instagramUsernameFromAcct(acct);
  return username ? `${username}@${INSTAGRAM_NETWORK_DOMAIN}` : null;
}

const resultCache = new Map<string, { expiresAt: number; result: InstagramGraphLookup }>();
let cooldownUntil = 0;

/** Test seam: in-process cache and throttle state are module singletons. */
export function resetInstagramGraphStateForTests(): void {
  resultCache.clear();
  cooldownUntil = 0;
}

function remember(username: string, result: InstagramGraphLookup): InstagramGraphLookup {
  if (resultCache.size >= RESULT_CACHE_MAX_ENTRIES) {
    const oldest = resultCache.keys().next().value;
    if (oldest !== undefined) resultCache.delete(oldest);
  }
  resultCache.set(username, { expiresAt: Date.now() + RESULT_CACHE_TTL_MS, result });
  return result;
}

function fail(
  reason: InstagramGraphFailureReason,
  context: Record<string, unknown> = {},
): InstagramGraphLookup {
  logger.warn('Instagram Graph lookup failed', {
    operation: 'instagram_graph_business_discovery',
    reason,
    ...context,
  });
  return { ok: false, reason };
}

function readJsonLimited(response: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (value: Record<string, unknown> | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    response.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > GRAPH_MAX_JSON_BYTES) {
        response.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks, total).toString('utf-8'));
        finish(
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null,
        );
      } catch {
        finish(null);
      }
    });
    response.on('error', () => finish(null));
    response.on('close', () => finish(null));
  });
}

/** Highest percentage in Meta's `x-app-usage` header, or undefined when absent/unparseable. */
function appUsagePercent(header: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return undefined;
  try {
    const usage: unknown = JSON.parse(raw);
    if (!usage || typeof usage !== 'object') return undefined;
    const values = Object.values(usage).filter(
      (value): value is number => typeof value === 'number' && Number.isFinite(value),
    );
    return values.length ? Math.max(...values) : undefined;
  } catch {
    return undefined;
  }
}

function stringField(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;
}

/**
 * Look one Instagram username up through Business Discovery. Only Business and
 * Creator accounts are visible; a personal or nonexistent account is `not_found`.
 */
export async function fetchInstagramGraphProfile(
  usernameOrAcct: string,
): Promise<InstagramGraphLookup> {
  const config = instagramGraphConfig();
  if (!config) return { ok: false, reason: 'not_configured' };
  const username = instagramUsernameFromAcct(usernameOrAcct);
  if (!username) return { ok: false, reason: 'invalid_username' };
  const cached = resultCache.get(username);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  if (cached) resultCache.delete(username);
  if (cooldownUntil > Date.now()) {
    return fail('throttled', {
      username,
      cooldownRemainingMs: cooldownUntil - Date.now(),
      phase: 'local_cooldown',
    });
  }

  // The username is validated against Instagram's alphabet before it is placed
  // inside the field expansion, so it cannot inject another field or edge.
  const fields = `business_discovery.username(${username}){id,username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count}`;
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${config.businessAccountId}?fields=${encodeURIComponent(fields)}`;
  let res: Awaited<ReturnType<typeof safeFetch>>;
  try {
    res = await safeFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${config.token}` },
      headersTimeoutMs: GRAPH_FETCH_TIMEOUT_MS,
      signal: AbortSignal.timeout(GRAPH_FETCH_TIMEOUT_MS),
      maxRedirects: 0,
    });
  } catch (error) {
    return fail('transport_unavailable', {
      username,
      ssrfRejected: error instanceof SsrfRejection,
    });
  }
  const usage = appUsagePercent(res.headers['x-app-usage']);
  if (usage !== undefined && usage >= APP_USAGE_COOLDOWN_PERCENT)
    cooldownUntil = Date.now() + THROTTLE_COOLDOWN_MS;
  const body = await readJsonLimited(res.response);
  if (!body)
    return fail('unreadable_document', {
      username,
      httpStatus: res.status,
      appUsagePercent: usage,
    });

  const error =
    body.error && typeof body.error === 'object'
      ? (body.error as Record<string, unknown>)
      : undefined;
  if (res.status < 200 || res.status >= 300 || error) {
    const code = typeof error?.code === 'number' ? error.code : undefined;
    const subcode = typeof error?.error_subcode === 'number' ? error.error_subcode : undefined;
    const context = {
      username,
      httpStatus: res.status,
      code,
      subcode,
      appUsagePercent: usage,
      fbtraceId: stringField(error?.fbtrace_id, 64),
    };
    if (subcode === NOT_A_BUSINESS_ACCOUNT_SUBCODE) {
      logger.info('Instagram Graph account not discoverable', {
        operation: 'instagram_graph_business_discovery',
        reason: 'not_found',
        ...context,
      });
      return remember(username, { ok: false, reason: 'not_found' });
    }
    if ((code !== undefined && THROTTLE_ERROR_CODES.has(code)) || res.status === 429) {
      cooldownUntil = Date.now() + THROTTLE_COOLDOWN_MS;
      return fail('throttled', context);
    }
    if (code === TOKEN_ERROR_CODE) return fail('token_invalid', context);
    return fail('http_status', context);
  }

  const discovered =
    body.business_discovery && typeof body.business_discovery === 'object'
      ? (body.business_discovery as Record<string, unknown>)
      : undefined;
  const igUserId =
    typeof discovered?.id === 'string' && GRAPH_USER_ID.test(discovered.id)
      ? discovered.id
      : undefined;
  const returnedUsername =
    typeof discovered?.username === 'string' ? discovered.username.toLowerCase() : undefined;
  if (!discovered || !igUserId)
    return fail('unreadable_document', { username, httpStatus: res.status });
  if (returnedUsername !== username)
    return fail('identity_mismatch', { username, httpStatus: res.status });

  const acct = `${username}@${INSTAGRAM_NETWORK_DOMAIN}`;
  const picture = stringField(discovered.profile_picture_url, 2048);
  const profile: ExternalActorProfile = {
    actorUri: instagramGraphActorUri(igUserId),
    protocol: INSTAGRAM_GRAPH_PROTOCOL,
    domain: INSTAGRAM_NETWORK_DOMAIN,
    username: acct,
    transportAcct: acct,
    displayName: stringField(discovered.name, 256) ?? username,
    bio: normalizeExternalBio(
      sanitizePlainText(stringField(discovered.biography, 4096) ?? ''),
      INSTAGRAM_NETWORK_DOMAIN,
      INSTAGRAM_NETWORK_DOMAIN,
    ),
    avatarUrl: picture?.startsWith('https://') ? picture : undefined,
    // Graph sources carry no rel=me claims and no stable id: they never create
    // cross-network edges and never trigger the stable-owner revocation path.
    evidenceLinks: [],
  };
  return remember(username, { ok: true, profile, igUserId });
}
