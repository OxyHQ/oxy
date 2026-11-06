/**
 * `oxy.session` — this client's auth state and its server session.
 *
 * The local half is synchronous state: the access token, the user id it
 * carries, change notifications. The remote half is the server session that
 * token belongs to: validating it, listing the sessions beside it, signing out.
 */
import { jwtDecode } from 'jwt-decode';
import type { AccountActorChain, DeviceProof } from '@oxy.so/contracts';
import type { OxyContext } from '../client/context';
import type { ClientSession } from '../models/session';
import type { User } from '../models/interfaces';
import { normalizeUserIdentity } from '../utils/userIdentity';
import { OxyApiError } from '../OxyServices.errors';
import { checkContract, holderContextEvidenceV1ResponseCheck } from '@oxy.so/contracts/client';
import type { CredentialGeneration } from '../HttpService';
import type {
  HolderEvidence,
  HolderEvidenceResult,
  HolderEvidenceUnavailableReason,
} from './holderEvidence';

const enc = encodeURIComponent;

/** How long a refusal (disabled, rate limited, unreachable) is remembered per installation. */
const EVIDENCE_REFUSAL_MS = 5_000;
const unavailable = (reason: HolderEvidenceUnavailableReason): HolderEvidenceResult => ({
  status: 'unavailable',
  reason,
});

/**
 * Reads the device credential this client holds, if any — `{ deviceId,
 * deviceSecret }` from the provider's auth store. See
 * {@link SessionApi.setDeviceCredentialProvider}.
 */
export type DeviceCredentialProvider = () => Promise<DeviceProof | null> | DeviceProof | null;

export interface SessionValidateOptions {
  deviceFingerprint?: string;
  useHeaderValidation?: boolean;
  /** The bearer the request being authorized carried; cross-checked against the session. */
  accessToken?: string;
}

export interface SessionValidation {
  valid: boolean;
  expiresAt: string;
  lastActivity: string;
  user: User;
  sessionId?: string;
  source?: string;
  /** Who acted, and as whom, read off the session row (issue #1520). */
  actor?: AccountActorChain;
}

interface AccessTokenClaims {
  exp?: number;
  userId?: string;
  id?: string;
  sessionId?: string;
  deviceId?: string;
  device_context_id?: string;
  act?: { sub?: string };
}

export class SessionApi {
  private deviceCredentialProvider: DeviceCredentialProvider | null = null;
  private decodedFor: string | null = null;
  private decoded: AccessTokenClaims | null = null;
  /** One server round trip per installed bearer; the key is the opaque generation. */
  private readonly evidence = new WeakMap<
    CredentialGeneration,
    { result: Promise<HolderEvidenceResult>; settledAt?: number }
  >();

  constructor(protected readonly ctx: OxyContext) {}

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
   * The session id the access token names (its `sessionId` claim); `null` when
   * signed out or the token does not say. On a session host (ADR 0058) this is
   * how the provider learns the shared session an application token belongs to.
   */
  get sessionId(): string | null {
    const sessionId = this.claims()?.sessionId;
    return typeof sessionId === 'string' && sessionId ? sessionId : null;
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
      if (
        proof &&
        typeof proof.deviceId === 'string' &&
        proof.deviceId &&
        typeof proof.deviceSecret === 'string' &&
        proof.deviceSecret
      ) {
        return { deviceId: proof.deviceId, deviceSecret: proof.deviceSecret };
      }
      return null;
    } catch {
      return null;
    }
  }

  // ── Holder-context evidence (ADR 0053) ───────────────────────────────────

  /**
   * Ask the server which shared-device context the INSTALLED bearer belongs to,
   * and bind the answer to that exact installation.
   *
   * The result is honored only if the credential generation captured before
   * the request is still current when the answer is committed, so a refresh,
   * setter, account or actor switch, cross-tab change, restore or A to B to A
   * during the request yields `changed`. The answer must also agree with the
   * claims of the bearer that was captured; a disagreement is
   * `binding_unavailable`. Nothing here refreshes, clears or mints a credential,
   * and no outcome is a revocation verdict: callers keep their existing checks.
   * Concurrent callers share one request per installation.
   */
  observeHolderEvidence(): Promise<HolderEvidenceResult> {
    const generation = this.ctx.http.captureCredentialGeneration();
    const token = this.ctx.http.getAccessToken();
    if (!generation || !token) return Promise.resolve(unavailable('no_credential'));
    const known = this.evidence.get(generation);
    if (known) {
      const refused = known.settledAt !== undefined;
      if (!refused || Date.now() - (known.settledAt as number) < EVIDENCE_REFUSAL_MS) {
        return known.result.then((result) =>
          result.status === 'ok' && result.evidence.expiresAtMs <= Date.now()
            ? this.refreshEvidence(generation, token)
            : result,
        );
      }
    }
    return this.refreshEvidence(generation, token);
  }

  /** Whether evidence still names the installed bearer and has not expired. */
  isHolderEvidenceCurrent(evidence: HolderEvidence): boolean {
    return (
      Date.now() < evidence.expiresAtMs &&
      this.ctx.http.isCredentialGenerationCurrent(evidence.generation)
    );
  }

  private refreshEvidence(
    generation: CredentialGeneration,
    token: string,
  ): Promise<HolderEvidenceResult> {
    const entry: { result: Promise<HolderEvidenceResult>; settledAt?: number } = {
      result: this.acquireEvidence(generation, token).then((result) => {
        if (result.status !== 'ok') entry.settledAt = Date.now();
        return result;
      }),
    };
    this.evidence.set(generation, entry);
    return entry.result;
  }

  private async acquireEvidence(
    generation: CredentialGeneration,
    token: string,
  ): Promise<HolderEvidenceResult> {
    let claims: AccessTokenClaims;
    try {
      claims = jwtDecode<AccessTokenClaims>(token);
    } catch {
      return unavailable('unsupported');
    }
    const proof = await this.readDeviceProof();
    if (!proof) return unavailable('no_holder');
    let response: unknown;
    try {
      response = await this.ctx.request<unknown>(
        'POST',
        '/session/device/context-evidence-v1',
        proof,
        {
          cache: false,
          retry: false,
          expectedCredentialGeneration: generation,
        },
      );
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'AUTH_SESSION_CHANGED') {
        return unavailable('changed');
      }
      const status = error instanceof OxyApiError ? error.status : 0;
      if (status === 403) return unavailable('unsupported');
      if (status === 409) return unavailable('binding_unavailable');
      return unavailable('unavailable');
    }
    const parsed = checkContract(holderContextEvidenceV1ResponseCheck, response);
    if (!parsed) return unavailable('unavailable');
    // Commit synchronously: nothing may replace the bearer between this check
    // and the evidence becoming visible to its caller.
    if (!this.ctx.http.isCredentialGenerationCurrent(generation)) return unavailable('changed');
    const expiresAtMs = Date.parse(parsed.expiresAt);
    if (
      parsed.deviceId !== proof.deviceId ||
      parsed.accountId !== claims.userId ||
      parsed.sessionId !== claims.sessionId ||
      (claims.act?.sub !== undefined && parsed.actorId !== claims.act.sub) ||
      (claims.device_context_id !== undefined && parsed.contextId !== claims.device_context_id)
    ) {
      return unavailable('binding_unavailable');
    }
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      return unavailable('unavailable');
    }
    const evidence: HolderEvidence = Object.freeze({
      generation,
      identity: Object.freeze({
        deviceId: parsed.deviceId,
        deviceSessionId: parsed.deviceSessionId,
        contextId: parsed.contextId,
        actorId: parsed.actorId,
        accountId: parsed.accountId,
        sessionId: parsed.sessionId,
      }),
      deviceRevision: parsed.revision,
      expiresAtMs,
    });
    return { status: 'ok', evidence };
  }

  // ── The server session ───────────────────────────────────────────────────

  /** Ask the server whether the current access token is valid. */
  async validateToken(): Promise<boolean> {
    if (!this.isAuthenticated) return false;
    try {
      const res = await this.ctx.request<{ valid: boolean }>('GET', '/auth/validate', undefined, {
        cache: false,
        retry: false,
      });
      return res.valid === true;
    } catch {
      return false;
    }
  }

  /**
   * Validate a session by id and return it with its user.
   *
   * With `accessToken` (a server validating the bearer its request carried)
   * Oxy also cross-checks that token against the session, so a token only ever
   * validates the session it was issued for.
   */
  async validate(
    sessionId: string,
    options: SessionValidateOptions = {},
  ): Promise<SessionValidation> {
    if ('liveSession' in options)
      throw new OxyApiError('Live session validation requires OxyServer', {
        status: 503,
        code: 'SESSION_AUTHORITY_UNAVAILABLE',
      });
    return this.validateRequest(sessionId, options);
  }

  /** Server implementations use this transport after enforcing their own contract. */
  protected async validateRequest(
    sessionId: string,
    options: SessionValidateOptions & { liveSession?: boolean },
  ): Promise<SessionValidation> {
    try {
      if (options.liveSession && !options.accessToken)
        throw new OxyApiError('Live session authority requires a bearer', {
          status: 503,
          code: 'SESSION_AUTHORITY_UNAVAILABLE',
        });
      const validation: SessionValidation & { liveSessionAuthority?: unknown } = options.accessToken
        ? await this.ctx.request<SessionValidation & { liveSessionAuthority?: unknown }>(
            'GET',
            `/session/validate-header/${encodeURIComponent(sessionId)}`,
            undefined,
            {
              cache: false,
              skipAuth: true,
              ...(options.liveSession ? { deduplicate: false, retry: false } : {}),
              headers: {
                Authorization: `Bearer ${options.accessToken}`,
                ...(options.liveSession
                  ? { 'x-oxy-session-authority': 'live-v1', 'cache-control': 'no-store' }
                  : {}),
                ...(options.deviceFingerprint
                  ? { 'x-device-fingerprint': options.deviceFingerprint }
                  : {}),
              },
            },
          )
        : await this.ctx.request<SessionValidation>(
            'GET',
            `/session/validate/${enc(sessionId)}`,
            {
              ...(options.deviceFingerprint
                ? { deviceFingerprint: options.deviceFingerprint }
                : {}),
              ...(options.useHeaderValidation ? { useHeaderValidation: 'true' } : {}),
            },
            { cache: false },
          );
      if (
        options.liveSession &&
        (validation.liveSessionAuthority !== 'session-row-v1' ||
          validation.valid !== true ||
          validation.sessionId !== sessionId ||
          typeof validation.expiresAt !== 'string' ||
          !Number.isFinite(Date.parse(validation.expiresAt)) ||
          Date.parse(validation.expiresAt) <= Date.now() ||
          typeof validation.lastActivity !== 'string' ||
          !Number.isFinite(Date.parse(validation.lastActivity)))
      )
        throw new OxyApiError('Live session authority is unavailable', {
          status: 503,
          code: 'SESSION_AUTHORITY_UNAVAILABLE',
        });
      return { ...validation, user: normalizeUserIdentity(validation.user) };
    } catch (error) {
      if (options.liveSession) {
        const candidate = error as { status?: unknown; code?: unknown } | null;
        const invalid =
          candidate?.status === 401 && candidate.code === 'OXY_LIVE_SESSION_INVALID_V1';
        const denied = candidate?.status === 403 && candidate.code === 'OXY_LIVE_SESSION_POLICY_V1';
        if (invalid) this.ctx.oxy.cache.delete(`GET:/session/user/${enc(sessionId)}`);
        if (invalid || denied) throw error;
        throw new OxyApiError('Live session authority is unavailable', {
          status: 503,
          code: 'SESSION_AUTHORITY_UNAVAILABLE',
          cause: error,
        });
      }
      // The session is gone: drop any user cached for it (#196).
      this.ctx.oxy.cache.delete(`GET:/session/user/${enc(sessionId)}`);
      throw error;
    }
  }

  /** The sessions that belong with `sessionId` (same account set). */
  async list(sessionId: string): Promise<ClientSession[]> {
    return this.ctx.request<ClientSession[]>(
      'GET',
      `/session/sessions/${enc(sessionId)}`,
      undefined,
      {
        cache: false,
      },
    );
  }

  /** Sign out `sessionId`, or — with `targetSessionId` — one of the sessions beside it. */
  async logout(sessionId: string, targetSessionId?: string): Promise<void> {
    const url = targetSessionId
      ? `/session/logout/${enc(sessionId)}/${enc(targetSessionId)}`
      : `/session/logout/${enc(sessionId)}`;
    await this.ctx.request('POST', url, undefined, { cache: false });
  }

  /** Sign out the other sessions for this account; preserve `sessionId`. */
  async logoutAll(sessionId: string): Promise<void> {
    await this.ctx.request('POST', `/session/logout-all/${enc(sessionId)}`, undefined, {
      cache: false,
    });
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
