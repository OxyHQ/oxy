/**
 * Dynamic Origin Registry — CORS allowlist derived from the Application registry.
 *
 * Registering an Application in OxyConsole (with `redirectUris`) must
 * automatically authorize that app's origin for CORS, with NO code change. The
 * trust gate is the canonical {@link isTrustedApplication} predicate — the SAME
 * staff-controlled boundary the OAuth consent auto-approve decision and the
 * device-first bootstrap `return_to` validation use — NOT `status: 'active'`
 * (every self-service third-party app is active too, so `active` alone is
 * never a trust boundary).
 *
 * Two snapshots are maintained in memory and swapped atomically on refresh:
 *  - `trustedOrigins`     — first-party / internal / system / official apps
 *    (plus the {@link BOOTSTRAP_CORE_ORIGINS} fail-safe seed and validated
 *    `OXY_EXTRA_ALLOWED_ORIGINS`). These get the CREDENTIALED CORS lane
 *    (`Access-Control-Allow-Credentials: true`) and pass the CSRF Origin guard.
 *  - `thirdPartyOrigins`  — ordinary active third-party apps. These get a
 *    NON-credentialed CORS lane only (bearer/PKCE public clients): an
 *    `Access-Control-Allow-Origin` echo WITHOUT credentials, so `oxy.so`
 *    cookies never ride a third-party request. They never enter the trusted
 *    snapshot, so they can never make a credentialed/CSRF-relevant request.
 *
 * `isTrustedApplication`'s inputs (`type`/`isOfficial`/`isInternal`) are
 * staff-only fields (never settable via Console / member RBAC — see
 * `requireStaff`), so a third-party app cannot self-promote into the
 * credentialed lane.
 *
 * Why a snapshot: `isAllowedOrigin` (CORS middleware, CSRF Origin guard,
 * Socket.IO config) is SYNCHRONOUS, but the trust set lives in the database.
 * The snapshot is refreshed in the background (boot + 60s interval + on-demand
 * from Application create/update/delete) and read synchronously. Fail-soft: a
 * database error keeps the previous snapshot.
 *
 * This module OWNS {@link BOOTSTRAP_CORE_ORIGINS} and the
 * `OXY_EXTRA_ALLOWED_ORIGINS` parser (rather than importing them from
 * `allowedOrigins.ts`) so the dependency is strictly one-directional
 * (`allowedOrigins.ts` → this module) — no import cycle, and the boot seed can
 * read its data synchronously at module load with no partial-export hazard.
 */

import { eq } from 'drizzle-orm';
import { getDb } from './postgres';
import { isDatabaseConnected } from '../utils/dbConnection';
import { applications } from '../db/schema/applications';
import { isTrustedApplication } from '../utils/trustedApplication';
import { normaliseOrigin, isLoopbackOrigin } from '../utils/origin';
import { isValidHostname } from './env';
import { logger } from '../utils/logger';

/**
 * Fail-safe core origins. Every first-party Oxy frontend + apex + CDN that must
 * keep working even if the database is unreachable at boot or the Application registry
 * has not been populated yet. The dynamic refresh UNIONS the trusted-app
 * origins on top of this set — it never removes a core origin — so the
 * migration to a fully registry-driven allowlist can never drop an origin that
 * already works in production. (A future trim is possible once the registry is
 * verified to cover all of these.)
 */
export const BOOTSTRAP_CORE_ORIGINS: ReadonlySet<string> = new Set([
  // ── oxy.so first-party frontends (Cloudflare Pages) + apex + CDN ──
  'https://oxy.so',
  'https://api.oxy.so',
  'https://accounts.oxy.so',
  'https://allo.oxy.so',
  'https://auth.oxy.so',
  'https://cloud.oxy.so',
  'https://console.oxy.so',
  'https://inbox.oxy.so',
  'https://noted.oxy.so',
  'https://os.oxy.so',
  'https://pay.oxy.so',
  'https://syra.oxy.so',
  // ── Oxy Website FairCoin redirect ──
  'https://fairco.in',
  // ── Mention ──
  'https://mention.earth',
  'https://api.mention.earth',
  'https://auth.mention.earth',
  // ── Homiio ──
  'https://homiio.com',
  'https://app.homiio.com',
  'https://auth.homiio.com',
  // ── Alia ──
  'https://alia.onl',
  'https://api.alia.onl',
  'https://auth.alia.onl',
  'https://canvas.alia.onl',
  // ── Syra ──
  'https://syra.fm',
  // ── Allo ──
  'https://allo.you',
  // ── TNP ──
  'https://tnp.network',
  // ── Moovo (storefront + first-party admin surfaces) ──
  'https://moovo.now',
  'https://go.moovo.now',
  'https://hub.moovo.now',
  // ── Mercaria (storefront + dashboard + point-of-sale) ──
  'https://mercaria.co',
  'https://dashboard.mercaria.co',
  'https://pos.mercaria.co',
]);

const HTTPS_PREFIX = 'https://';

/**
 * Parse + validate `OXY_EXTRA_ALLOWED_ORIGINS`. Each entry must be an
 * `https://<hostname>` origin whose hostname passes the strict
 * `isValidHostname` check (the same one used for cookie domains). Invalid
 * entries are logged and dropped — they never widen the allowlist.
 *
 * Memoized on the raw env value so per-request lookups stay O(1) while still
 * picking up changes (tests, hot reconfiguration). This is the SINGLE parser
 * for the emergency escape hatch — both the synchronous `isAllowedOrigin`
 * fallback and the trusted snapshot read from it.
 */
let extraOriginsCacheKey: string | undefined;
let extraOriginsCache: ReadonlySet<string> = new Set();

export function getExtraAllowedOrigins(): ReadonlySet<string> {
  const raw = process.env.OXY_EXTRA_ALLOWED_ORIGINS ?? '';
  if (raw === extraOriginsCacheKey) {
    return extraOriginsCache;
  }

  const parsed = new Set<string>();
  for (const entry of raw.split(',')) {
    const candidate = entry.trim();
    if (candidate.length === 0) {
      continue;
    }
    if (!candidate.startsWith(HTTPS_PREFIX)) {
      logger.warn('OXY_EXTRA_ALLOWED_ORIGINS entry rejected: not https', { entry: candidate });
      continue;
    }
    const hostname = candidate.slice(HTTPS_PREFIX.length);
    if (!isValidHostname(hostname)) {
      logger.warn('OXY_EXTRA_ALLOWED_ORIGINS entry rejected: invalid hostname', { entry: candidate });
      continue;
    }
    parsed.add(candidate);
  }

  extraOriginsCacheKey = raw;
  extraOriginsCache = parsed;
  return parsed;
}

/** CORS decision for a single request origin. */
export interface CorsDecision {
  /** Whether to echo `Access-Control-Allow-Origin: <origin>` at all. */
  allow: boolean;
  /** Whether to additionally send `Access-Control-Allow-Credentials: true`. */
  credentials: boolean;
}

/** Refresh cadence for the background snapshot rebuild. */
const REFRESH_INTERVAL_MS = 60_000;

/**
 * The four `applications` columns origin derivation reads.
 *
 * Named explicitly rather than `select()`-ing the table: the three trust fields
 * plus `redirect_uris` are the whole input to {@link isTrustedApplication} and
 * the origin split, and a whole-row read would hand this module every other
 * column of an application it has no business seeing.
 */
const ORIGIN_COLUMNS = {
  redirectUris: applications.redirectUris,
  isOfficial: applications.isOfficial,
  isInternal: applications.isInternal,
  type: applications.type,
} as const;

/**
 * Holds the two origin snapshots and the background refresh timer. A single
 * module-private instance is exposed through the named functions below so call
 * sites read a stable functional surface (mirrors `isAllowedOrigin`).
 */
class DynamicOriginRegistry {
  private trustedOrigins: Set<string>;
  private thirdPartyOrigins: Set<string>;
  private timer: NodeJS.Timeout;

  constructor() {
    // Boot seed: trusted = bootstrap-core ∪ validated extra origins. This makes
    // the very first synchronous read safe before the first async refresh
    // resolves (or if the database is unreachable at boot).
    this.trustedOrigins = this.seedTrusted();
    this.thirdPartyOrigins = new Set<string>();

    this.timer = setInterval(() => {
      void this.refresh();
    }, REFRESH_INTERVAL_MS);
    // Never keep the event loop alive for this background refresh.
    this.timer.unref();
  }

  private seedTrusted(): Set<string> {
    const seed = new Set<string>(BOOTSTRAP_CORE_ORIGINS);
    for (const origin of getExtraAllowedOrigins()) {
      seed.add(origin);
    }
    return seed;
  }

  /**
   * Rebuild both snapshots from the Application registry. Atomic: builds fresh
   * Sets, then swaps them in. Fail-soft: on a database error the previous
   * snapshots are kept (logged), so a transient DB hiccup never collapses the
   * allowlist.
   *
   * FAIL SAFE, and the direction matters: every failure path here LEAVES THE
   * PREVIOUS SNAPSHOT IN PLACE — it never publishes a partial or empty one. An
   * empty trusted set would deny the credentialed CORS lane to every
   * first-party frontend at once, so "the database is unreachable" must never
   * be able to narrow the allowlist. The boot seed
   * ({@link BOOTSTRAP_CORE_ORIGINS} ∪ validated extras) is the floor a
   * never-successful refresh leaves standing.
   */
  async refresh(): Promise<void> {
    // Skip work before the pool is open (module import happens long before
    // startup connects, and unit tests import this transitively via the CORS /
    // CSRF Origin primitives). `getDb()` THROWS when called early, and throwing
    // through the interval callback below would be an unhandled rejection, so
    // the synchronous check is the guard rather than the catch.
    if (!isDatabaseConnected()) {
      return;
    }
    try {
      const apps = await getDb()
        .select(ORIGIN_COLUMNS)
        .from(applications)
        .where(eq(applications.status, 'active'));

      const nextTrusted = this.seedTrusted();
      const nextThirdParty = new Set<string>();

      for (const app of apps) {
        const trusted = isTrustedApplication(app);
        for (const uri of app.redirectUris) {
          const origin = normaliseOrigin(uri);
          if (!origin) continue;
          if (trusted) {
            nextTrusted.add(origin);
          } else {
            nextThirdParty.add(origin);
          }
        }
      }

      // An origin that is trusted (bootstrap / trusted app / extra) must NEVER
      // also appear as a third-party-only origin, even if some third-party app
      // happens to register the same redirect origin. Trusted always wins.
      for (const origin of nextTrusted) {
        nextThirdParty.delete(origin);
      }

      this.trustedOrigins = nextTrusted;
      this.thirdPartyOrigins = nextThirdParty;
    } catch (error) {
      logger.error('dynamicOriginRegistry: refresh failed, keeping previous snapshot', error);
    }
  }

  isTrustedOrigin(origin: string): boolean {
    return this.trustedOrigins.has(origin);
  }

  getCorsDecision(origin: string): CorsDecision {
    // Loopback dev origins ALWAYS get the credentialed lane, and win over the
    // third-party lane below: a localhost origin that a third-party app happens
    // to register as a redirectUri must still be able to send credentialed
    // requests (SDK `credentials:'include'` fetch of `/csrf-token`).
    if (this.trustedOrigins.has(origin) || isLoopbackOrigin(origin)) {
      return { allow: true, credentials: true };
    }
    if (this.thirdPartyOrigins.has(origin)) {
      return { allow: true, credentials: false };
    }
    return { allow: false, credentials: false };
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Test-only: deterministically set both snapshots. */
  setSnapshotForTests(trusted: readonly string[], thirdParty: readonly string[]): void {
    this.trustedOrigins = new Set(trusted);
    this.thirdPartyOrigins = new Set(thirdParty);
  }

  /** Test-only: restore the boot seed (bootstrap-core ∪ extra). */
  resetForTests(): void {
    this.trustedOrigins = this.seedTrusted();
    this.thirdPartyOrigins = new Set<string>();
  }
}

const registry = new DynamicOriginRegistry();

/** Is `origin` in the trusted (credentialed) snapshot? */
export function isTrustedOrigin(origin: string): boolean {
  return registry.isTrustedOrigin(origin);
}

/** CORS decision (allow / credentials) for `origin`. */
export function getCorsDecision(origin: string): CorsDecision {
  return registry.getCorsDecision(origin);
}

/** Rebuild the snapshots from the Application registry (background-safe). */
export function refreshOriginRegistry(): Promise<void> {
  return registry.refresh().then(async () => {
    const { reconcileOfficialRedirectUris } = await import('./reconcileOfficialRedirectUris.js');
    await reconcileOfficialRedirectUris();
  });
}

/** Stop the background refresh interval (tests / graceful shutdown). */
export function stopOriginRegistry(): void {
  registry.stop();
}

/** Test-only: set both snapshots deterministically. */
export function setOriginSnapshotForTests(
  trusted: readonly string[],
  thirdParty: readonly string[]
): void {
  registry.setSnapshotForTests(trusted, thirdParty);
}

/** Test-only: restore the boot seed snapshot. */
export function resetOriginRegistryForTests(): void {
  registry.resetForTests();
}

export default registry;
