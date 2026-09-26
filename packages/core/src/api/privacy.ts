/**
 * `oxy.privacy` — privacy settings, blocked and restricted users.
 */
import type { BlockedUser, PrivacySettings, RestrictedUser } from '../models/interfaces';
import type { OxyContext } from '../client/context';
import { evictOxyIdentityCache } from '../utils/identityCacheSweep';

const LIST_TTL = 60 * 1000;
const SETTINGS_TTL = 2 * 60 * 1000;

type UserRef = string | { _id: string };

const refId = (ref: UserRef): string => (typeof ref === 'string' ? ref : ref._id);

export class PrivacyApi {
  constructor(private readonly ctx: OxyContext) {}

  // ── Settings ─────────────────────────────────────────────────────────────

  /** A user's privacy settings (default: the signed-in user's). */
  async settings(userId?: string): Promise<PrivacySettings> {
    const id = await this.resolveUserId(userId);
    return this.ctx.request<PrivacySettings>('GET', `/privacy/${id}/privacy`, undefined, {
      cache: true,
      cacheTTL: SETTINGS_TTL,
    });
  }

  /** Update privacy settings (default: the signed-in user's). */
  async updateSettings(settings: Partial<PrivacySettings>, userId?: string): Promise<PrivacySettings> {
    const id = await this.resolveUserId(userId);
    const res = await this.ctx.request<PrivacySettings>('PATCH', `/privacy/${id}/privacy`, settings, { cache: false });
    // Privacy settings ride the user DTO, so every identity read goes stale too.
    evictOxyIdentityCache(this.ctx.http, id);
    this.ctx.oxy.cache.delete(`GET:/privacy/${id}/privacy`);
    return res;
  }

  // ── Blocked ──────────────────────────────────────────────────────────────

  /** The signed-in user's blocked users. */
  async blocked(): Promise<BlockedUser[]> {
    return this.ctx.request<BlockedUser[]>('GET', '/privacy/blocked', undefined, { cache: true, cacheTTL: LIST_TTL });
  }

  /** Block a user. */
  async block(userId: string): Promise<{ message: string }> {
    requireId(userId);
    const res = await this.ctx.request<{ message: string }>('POST', `/privacy/blocked/${userId}`, undefined, { cache: false });
    this.invalidate('GET:/privacy/blocked');
    return res;
  }

  /** Unblock a user. */
  async unblock(userId: string): Promise<{ message: string }> {
    requireId(userId);
    const res = await this.ctx.request<{ message: string }>('DELETE', `/privacy/blocked/${userId}`, undefined, { cache: false });
    this.invalidate('GET:/privacy/blocked');
    return res;
  }

  /** Whether the signed-in user blocked `userId`. `false` when the list cannot be read. */
  async isBlocked(userId: string): Promise<boolean> {
    if (!userId) return false;
    try {
      return (await this.blocked()).some((b) => refId(b.blockedId) === userId);
    } catch {
      return false;
    }
  }

  // ── Restricted ───────────────────────────────────────────────────────────

  /** The signed-in user's restricted users. */
  async restricted(): Promise<RestrictedUser[]> {
    return this.ctx.request<RestrictedUser[]>('GET', '/privacy/restricted', undefined, { cache: true, cacheTTL: LIST_TTL });
  }

  /** Restrict a user: limit their interactions without blocking them. */
  async restrict(userId: string): Promise<{ message: string }> {
    requireId(userId);
    const res = await this.ctx.request<{ message: string }>('POST', `/privacy/restricted/${userId}`, undefined, { cache: false });
    this.invalidate('GET:/privacy/restricted');
    return res;
  }

  /** Lift a restriction. */
  async unrestrict(userId: string): Promise<{ message: string }> {
    requireId(userId);
    const res = await this.ctx.request<{ message: string }>('DELETE', `/privacy/restricted/${userId}`, undefined, { cache: false });
    this.invalidate('GET:/privacy/restricted');
    return res;
  }

  /** Whether the signed-in user restricted `userId`. `false` when the list cannot be read. */
  async isRestricted(userId: string): Promise<boolean> {
    if (!userId) return false;
    try {
      return (await this.restricted()).some((r) => refId(r.restrictedId) === userId);
    } catch {
      return false;
    }
  }

  /**
   * A block or restriction changes the list AND the viewer's consolidated graph
   * (`blockedIds` / `restrictedIds` in `GET /users/me/graph`); both go.
   */
  private invalidate(listKey: string): void {
    this.ctx.http.invalidateCache({ keys: [listKey, 'GET:/users/me/graph'] });
  }

  private async resolveUserId(userId?: string): Promise<string> {
    return userId || this.ctx.oxy.session.userId || (await this.ctx.oxy.users.me()).id;
  }
}

function requireId(userId: string): void {
  if (!userId) throw new Error('User ID is required');
}
