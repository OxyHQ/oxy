/**
 * `oxy.session` — this client's auth state and its server session.
 *
 * The local half is synchronous state: the access token, the user id it
 * carries, change notifications. The remote half is the server session that
 * token belongs to: validating it, listing the sessions beside it, signing out.
 */
import { jwtDecode } from 'jwt-decode';
import type { DeviceProof } from '@oxy.so/contracts';
import type { OxyContext } from '../client/context';
import type { ClientSession } from '../models/session';
import type { User } from '../models/interfaces';
import { normalizeUserIdentity } from '../utils/userIdentity';

/**
 * Reads the device credential this client holds, if any — `{ deviceId,
 * deviceSecret }` from the provider's auth store. See
 * {@link SessionApi.setDeviceCredentialProvider}.
 */
export type DeviceCredentialProvider = () => Promise<DeviceProof | null> | DeviceProof | null;

export interface SessionValidation {
  valid: boolean;
  expiresAt: string;
  lastActivity: string;
  user: User;
  sessionId?: string;
  source?: string;
}

interface AccessTokenClaims {
  exp?: number;
  userId?: string;
  id?: string;
}

export class SessionApi {
  private deviceCredentialProvider: DeviceCredentialProvider | null = null;
  private decodedFor: string | null = null;
  private decoded: AccessTokenClaims | null = null;

  constructor(private readonly ctx: OxyContext) {}

  // ── Local state ──────────────────────────────────────────────────────────

  /** The current access token, or `null` when signed out. */
  get accessToken(): string | null {
    return this.ctx.http.getAccessToken();
  }

  /** Whether an access token is held. Does not ask the server; see `validateToken`. */
  get isAuthenticated(): boolean {
    return this.ctx.http.hasAccessToken();
  }

  /** The signed-in user's id, from the access token; `null` when signed out. */
  get userId(): string | null {
    const claims = this.claims();
    return claims?.userId || claims?.id || null;
  }

  /**
   * The access token's `exp` in SECONDS since the epoch (the raw JWT unit), or
   * `null` when there is no token or it carries no numeric `exp`. Powers the
   * proactive refresh timer in `@oxy.so/services`.
   */
  get accessTokenExpiry(): number | null {
    const exp = this.claims()?.exp;
    return typeof exp === 'number' ? exp : null;
  }

  /** Plant an access token (e.g. one a sign-in returned). */
  setAccessToken(accessToken: string): void {
    this.ctx.http.setTokens(accessToken);
  }

  /**
   * Forget the token and end the local session: a re-mint already in flight
   * plants nothing, and none runs until a token is set again.
   */
  clear(): void {
    this.ctx.http.endSession();
  }

  /**
   * Subscribe to access-token changes — `setAccessToken`, `clear`, a silent
   * refresh, the 401-driven clear. The listener gets the new token, or `null`.
   * Returns the unsubscribe.
   */
  onChange(listener: (accessToken: string | null) => void): () => void {
    return this.ctx.http.addTokenChangeListener(listener);
  }

  /**
   * Resolve `true` as soon as a token is held, or `false` after `timeoutMs`.
   * Event-driven: no polling.
   */
  waitForAuth(timeoutMs = 5000): Promise<boolean> {
    if (this.isAuthenticated) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        unsubscribe();
        resolve(false);
      }, timeoutMs);
      const unsubscribe = this.onChange((token) => {
        if (!token) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(true);
      });
    });
  }

  /**
   * Tell this client how to read the device credential it holds, so a sign-in
   * can PROVE the device (ADR 0029 D2): every sign-in in `oxy.auth` then sends
   * it as `device`, and the server puts the new session on that device — the
   * browser's shared one, which every Oxy app holding it sees at once.
   *
   * `OxyProvider` wires this from its auth store; nothing else needs to.
   * Returns a disposer that clears it (only if still installed).
   */
  setDeviceCredentialProvider(provider: DeviceCredentialProvider | null): () => void {
    this.deviceCredentialProvider = provider;
    return () => {
      if (this.deviceCredentialProvider === provider) {
        this.deviceCredentialProvider = null;
      }
    };
  }

  /**
   * The device proof a sign-in should carry, or `null`. Never throws: a store
   * that cannot be read only means the sign-in gets its own device.
   */
  async readDeviceProof(): Promise<DeviceProof | null> {
    const provider = this.deviceCredentialProvider;
    if (!provider) return null;
    try {
      const proof = await provider();
      if (proof && typeof proof.deviceId === 'string' && proof.deviceId && typeof proof.deviceSecret === 'string' && proof.deviceSecret) {
        return { deviceId: proof.deviceId, deviceSecret: proof.deviceSecret };
      }
      return null;
    } catch {
      return null;
    }
  }

  // ── The server session ───────────────────────────────────────────────────

  /** Ask the server whether the current access token is valid. */
  async validateToken(): Promise<boolean> {
    if (!this.isAuthenticated) return false;
    try {
      const res = await this.ctx.request<{ valid: boolean }>('GET', '/auth/validate', undefined, { cache: false, retry: false });
      return res.valid === true;
    } catch {
      return false;
    }
  }

  /** Validate a session by id and return it with its user. */
  async validate(
    sessionId: string,
    options: { deviceFingerprint?: string; useHeaderValidation?: boolean } = {},
  ): Promise<SessionValidation> {
    const params: Record<string, string> = {};
    if (options.deviceFingerprint) params.deviceFingerprint = options.deviceFingerprint;
    if (options.useHeaderValidation) params.useHeaderValidation = 'true';
    try {
      const validation = await this.ctx.request<SessionValidation>('GET', `/session/validate/${sessionId}`, params, { cache: false });
      return { ...validation, user: normalizeUserIdentity(validation.user) };
    } catch (error) {
      // The session is gone: drop any user cached for it (#196).
      this.ctx.oxy.cache.delete(`GET:/session/user/${sessionId}`);
      throw error;
    }
  }

  /** The sessions that belong with `sessionId` (same account set). */
  async list(sessionId: string): Promise<ClientSession[]> {
    return this.ctx.request<ClientSession[]>('GET', `/session/sessions/${sessionId}`, undefined, { cache: false });
  }

  /** Sign out `sessionId`, or — with `targetSessionId` — one of the sessions beside it. */
  async logout(sessionId: string, targetSessionId?: string): Promise<void> {
    const url = targetSessionId ? `/session/logout/${sessionId}/${targetSessionId}` : `/session/logout/${sessionId}`;
    await this.ctx.request('POST', url, undefined, { cache: false });
  }

  /** Sign out every session beside `sessionId`, and it. */
  async logoutAll(sessionId: string): Promise<void> {
    await this.ctx.request('POST', `/session/logout-all/${sessionId}`, undefined, { cache: false });
  }

  /** Decoded claims of the current token, memoised per token string. */
  private claims(): AccessTokenClaims | null {
    const token = this.ctx.http.getAccessToken();
    if (token !== this.decodedFor) {
      this.decodedFor = token;
      try {
        this.decoded = token ? jwtDecode<AccessTokenClaims>(token) : null;
      } catch {
        this.decoded = null;
      }
    }
    return this.decoded;
  }
}
