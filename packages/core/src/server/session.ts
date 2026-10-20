/**
 * `OxyServer`'s `session`: the client session API, plus the reviewed
 * supervised-action lane its auth middleware validates through (ADR 0041),
 * plus a short per-process cache of successful bearer validations.
 *
 * Server-only, so the Zod schemas parse here; `../api/session.ts` stays on the
 * client entry without them.
 *
 * ## The validation cache, and how soon a revocation lands
 *
 * `middleware.auth()` validates every user bearer against its session
 * (`GET /session/validate-header/:id`) — a full Oxy round trip in front of
 * every authenticated request. User access tokens are HS256 under a secret only
 * oxy-api holds, so a backend cannot verify one locally; it can only remember
 * what Oxy answered. A SUCCESSFUL answer is reused per (session, SHA-256 of the
 * bearer) — never the raw token — for {@link SESSION_VALIDATION_CACHE_TTL_MS}
 * (30 s) by default, and never past the token's own `exp`.
 *
 * MAX STALENESS — the security contract: a revoked or signed-out session keeps
 * validating on THIS process for at most the TTL. Sooner where a signal exists:
 * the `oxy:user:invalidate` broadcast (`createOxyUserInvalidationHandler`,
 * which covers account status) drops that user's entries, and a logout made
 * through this client drops its session's. A load that started before an
 * invalidation never populates the cache. Failures and `valid: false` answers
 * are never cached. `fresh: true` skips the cache (and refreshes it);
 * `sessionValidationCacheTtlMs: 0` on the server config disables it.
 */
import { createHash } from 'node:crypto';
import {
  type SupervisedAction,
  safetySessionInputSchema,
  safetySessionValidationSchema,
} from '@oxy.so/contracts';
import { jwtDecode } from 'jwt-decode';
import type { OxyContext } from '../client/context';
import { SessionApi, type SessionValidateOptions, type SessionValidation } from '../api/session';
import type { User } from '../models/interfaces';
import { normalizeUserIdentity } from '../utils/userIdentity';

/** Default lifetime of one cached validation. */
export const SESSION_VALIDATION_CACHE_TTL_MS = 30_000;
/** Entries kept per server; the oldest goes first. */
const SESSION_VALIDATION_CACHE_MAX = 5_000;

export interface ServerSessionValidateOptions extends SessionValidateOptions {
  /**
   * A reviewed route category. Oxy then validates the bearer through this
   * service's live `safety:<action>:v1` authority, the only lane a supervised
   * account's session passes.
   */
  supervisedAction?: SupervisedAction;
  /** Skip the validation cache and ask Oxy (a success still refreshes it). */
  fresh?: boolean;
}

interface CachedValidation {
  value: SessionValidation;
  sessionId: string;
  /** The account the session speaks as, and the human operating it when delegated. */
  accountIds: readonly string[];
  expiresAt: number;
}

export class ServerSessionApi extends SessionApi {
  private readonly validations = new Map<string, CachedValidation>();
  private readonly pending = new Map<string, Promise<SessionValidation>>();
  /**
   * One counter stamps every invalidation: globally for an explicit one, per
   * session for a refusal. A load caches only if nothing it covers was stamped
   * since it began, so an older success cannot re-cache a revoked session.
   */
  private generation = 0;
  private epoch = 0;
  private readonly sessionStamps = new Map<string, number>();

  constructor(
    ctx: OxyContext,
    private readonly validationTtlMs = SESSION_VALIDATION_CACHE_TTL_MS,
  ) {
    super(ctx);
  }

  override async validate(
    sessionId: string,
    options: ServerSessionValidateOptions = {},
  ): Promise<SessionValidation> {
    const { supervisedAction, fresh, ...rest } = options;
    if (supervisedAction) return this.validateSupervised(sessionId, supervisedAction, rest);
    if (!rest.accessToken || rest.deviceFingerprint || this.validationTtlMs <= 0) {
      return super.validate(sessionId, rest);
    }

    const tokenExpiresAt = readTokenExpiry(rest.accessToken);
    if (tokenExpiresAt === null) return super.validate(sessionId, rest);
    const key = `${sessionId}:${createHash('sha256').update(rest.accessToken).digest('base64url')}`;
    if (!fresh) {
      const cached = this.validations.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const inFlight = this.pending.get(key);
      if (inFlight) return inFlight;
    }

    const stamp = this.stampOf(sessionId);
    const expiresAt = Math.min(Date.now() + this.validationTtlMs, tokenExpiresAt);
    const lookup = super.validate(sessionId, rest).then(
      (value) => {
        const userId = value.valid === true ? value.user?.id : undefined;
        if (!userId) this.refuse(sessionId);
        else if (stamp === this.stampOf(sessionId)) {
          const actorId = value.actor?.actorAccountId;
          const accountIds = actorId && actorId !== userId ? [userId, actorId] : [userId];
          this.remember(key, { value, sessionId, accountIds, expiresAt });
        }
        return value;
      },
      (error: unknown) => {
        this.refuse(sessionId);
        throw error;
      },
    );
    if (fresh) return lookup;
    this.pending.set(key, lookup);
    try {
      return await lookup;
    } finally {
      if (this.pending.get(key) === lookup) this.pending.delete(key);
    }
  }

  /**
   * Forget cached validations: every one, one session's, or one user's (as the
   * session's account or its delegated operator). For a backend that learns of
   * a revocation out of band.
   */
  invalidateValidations(filter: { userId?: string; sessionId?: string } = {}): void {
    // Loads already under way answered for the world before this signal.
    this.generation += 1;
    this.epoch = this.generation;
    this.sessionStamps.clear();
    this.pending.clear();
    if (!filter.userId && !filter.sessionId) this.validations.clear();
    else this.forget(filter);
  }

  override async logout(sessionId: string, targetSessionId?: string): Promise<void> {
    await super.logout(sessionId, targetSessionId);
    this.invalidateValidations({ sessionId: targetSessionId ?? sessionId });
  }

  override async logoutAll(sessionId: string): Promise<void> {
    const userId = [...this.validations.values()].find((entry) => entry.sessionId === sessionId)
      ?.accountIds[0];
    await super.logoutAll(sessionId);
    // Every session of the account ended; without its id here, forget them all.
    this.invalidateValidations(userId ? { userId } : {});
  }

  private stampOf(sessionId: string): number {
    return Math.max(this.epoch, this.sessionStamps.get(sessionId) ?? 0);
  }

  /** Oxy refused the session: drop it, and keep older in-flight successes from re-caching it. */
  private refuse(sessionId: string): void {
    this.generation += 1;
    this.sessionStamps.set(sessionId, this.generation);
    if (this.sessionStamps.size > SESSION_VALIDATION_CACHE_MAX) {
      this.sessionStamps.clear();
      this.epoch = this.generation;
    }
    for (const key of this.pending.keys()) {
      if (key.startsWith(`${sessionId}:`)) this.pending.delete(key);
    }
    this.forget({ sessionId });
  }

  private forget(filter: { userId?: string; sessionId?: string }): void {
    for (const [key, entry] of this.validations) {
      if (
        entry.sessionId === filter.sessionId ||
        (filter.userId !== undefined && entry.accountIds.includes(filter.userId))
      ) {
        this.validations.delete(key);
      }
    }
  }

  private remember(key: string, entry: CachedValidation): void {
    if (entry.expiresAt <= Date.now()) return;
    this.validations.delete(key);
    this.validations.set(key, entry);
    if (this.validations.size > SESSION_VALIDATION_CACHE_MAX) {
      const oldest = this.validations.keys().next().value;
      if (oldest !== undefined) this.validations.delete(oldest);
    }
  }

  private async validateSupervised(
    sessionId: string,
    supervisedAction: SupervisedAction,
    options: SessionValidateOptions,
  ): Promise<SessionValidation> {
    if (!this.ctx.service?.available || !options.accessToken) {
      throw new Error(
        'Reviewed supervision validation requires service identity and the original bearer',
      );
    }
    try {
      const validation = safetySessionValidationSchema.parse(
        await this.ctx.service.request(
          'POST',
          '/safety/service/session',
          safetySessionInputSchema.parse({
            sessionId,
            accessToken: options.accessToken,
            action: supervisedAction,
          }),
          { cache: false, retry: false, serviceTokenScopes: ['safety:decide'] },
        ),
      );
      return { ...validation, user: normalizeUserIdentity(validation.user) as User };
    } catch (error) {
      // The session is gone: drop any user cached for it (#196).
      this.ctx.oxy.cache.delete(`GET:/session/user/${sessionId}`);
      throw error;
    }
  }
}

/** The bearer's `exp` in epoch ms, `Infinity` without one, `null` when it does not decode. */
function readTokenExpiry(accessToken: string): number | null {
  try {
    const { exp } = jwtDecode<{ exp?: unknown }>(accessToken);
    return typeof exp === 'number' ? exp * 1000 : Number.POSITIVE_INFINITY;
  } catch {
    return null;
  }
}
