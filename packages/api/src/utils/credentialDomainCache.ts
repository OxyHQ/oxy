import { logger } from './logger';

/**
 * In-process cache mapping an Application `_id` to the set of federation domains
 * (hostnames) that its service credentials are allowed to sign for.
 *
 * SECURITY BOUNDARY: the federation sign/public-key endpoints must only let a
 * credential operate on keyIds whose host belongs to that credential's own
 * Application. The Application model has no explicit "federation domain" field,
 * so — exactly as the trusted-origin registry is DERIVED from active
 * `Application.redirectUris` (`dynamicOriginRegistry`) — we derive the
 * allowed federation hosts from the hostnames of the Application's
 * `redirectUris`. Registering Mention with a `https://mention.earth/oauth/callback`
 * redirect therefore authorises that credential to sign `mention.earth`
 * keyIds. Nothing is hand-maintained.
 *
 * FAIL CLOSED: if the Application is missing, not `active`, or has no usable
 * redirectUri hosts, the allowed set is EMPTY and every host check fails (403).
 * The loader is the caller's responsibility and must itself fail closed (return
 * an empty array on DB error) so a transient database hiccup denies rather than
 * admits.
 *
 * MULTI-TASK CAVEAT: oxy-api runs as multiple ECS Fargate tasks, so this Map is
 * per-task. Redirect-URI changes propagate within {@link DEFAULT_TTL} per task —
 * acceptable for a rarely-changing, additively-scoped allow-list, and the host
 * check is re-evaluated on every request against the freshly-cached set.
 */

const DEFAULT_TTL = 60_000; // 60s — short trust-boundary TTL for federation domain cache
const LOG_COMPONENT = 'CredentialDomainCache';

interface CacheEntry {
  domains: Set<string>;
  timestamp: number;
}

class CredentialDomainCache {
  private local = new Map<string, CacheEntry>();
  private cleanupTimer: NodeJS.Timeout;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), DEFAULT_TTL);
    // Don't keep the event loop alive solely for cache cleanup.
    if (typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Return the cached allowed-domains set for an appId, otherwise invoke
   * `loader()` (the uncached database read), store the result, and return it.
   */
  async getAllowedDomains(appId: string, loader: () => Promise<string[]>): Promise<Set<string>> {
    const cached = this.getLocal(appId);
    if (cached) return cached;

    let domains: string[];
    try {
      domains = await loader();
    } catch (error) {
      // Fail closed: a loader error yields an empty allow-list, never a default.
      logger.error('credentialDomainCache: loader failed; denying', {
        component: LOG_COMPONENT,
        appId,
        err: error instanceof Error ? error.message : String(error),
      });
      domains = [];
    }

    const set = new Set(domains);
    this.local.set(appId, { domains: set, timestamp: Date.now() });
    return set;
  }

  /** Drop a single appId's cached entry (e.g. when its redirectUris change). */
  invalidate(appId: string): void {
    this.local.delete(appId);
  }

  /** Drop everything. */
  clear(): void {
    this.local.clear();
  }

  stop(): void {
    clearInterval(this.cleanupTimer);
  }

  private getLocal(appId: string): Set<string> | null {
    const entry = this.local.get(appId);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > DEFAULT_TTL) {
      this.local.delete(appId);
      return null;
    }
    return entry.domains;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [appId, entry] of this.local.entries()) {
      if (now - entry.timestamp > DEFAULT_TTL) {
        this.local.delete(appId);
      }
    }
  }
}

const credentialDomainCache = new CredentialDomainCache();
export default credentialDomainCache;
