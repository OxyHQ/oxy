/**
 * `oxy.devices` — this user's devices, the sessions on them, their security
 * activity, and device sign-in.
 *
 * Device sign-in is the client half of the zero-cookie device transport:
 * {@link DevicesApi.mintToken} turns a first-party `deviceId` + `deviceSecret`
 * into a fresh access token (the cold boot and the re-mint handler call it);
 * {@link DevicesApi.registerBrowser}, {@link DevicesApi.requestJoinCode} and
 * {@link DevicesApi.joinBrowser} are the browser bridge (ADR 0029 D2); and
 * {@link DevicesApi.provisionBackgroundCredential} hands native background code
 * its own non-rotating credential. The mint carries NO persistence or
 * token-planting side effects: the cold boot / re-mint handler own those.
 */
import {
  deviceBackgroundCredentialResponseSchema,
  deviceJoinCodeResponseSchema,
  deviceJoinResponseSchema,
  deviceRegisterResponseSchema,
  deviceTokenMintResponseSchema,
  safeParseContract,
  type DeviceBackgroundCredentialResponse,
  type DeviceJoinCodeRequest,
  type DeviceJoinCodeResponse,
  type DeviceJoinRequest,
  type DeviceJoinResponse,
  type DeviceRegisterResponse,
  type DeviceTokenMintResponse,
} from '@oxy.so/contracts';
import type { OxyContext } from '../client/context';
import type {
  DeviceLinkedSession,
  DeviceLinkedSessionLogoutResponse,
  SecurityActivity,
  SecurityActivityResponse,
  SecurityEventType,
} from '../models/interfaces';
import { logger } from '../logger';
import { extractErrorStatus } from '../utils/errorUtils';

/** One of the signed-in user's devices (`GET /devices`). */
export interface UserDevice {
  id: string;
  deviceId: string;
  name: string;
  deviceName: string;
  type: string;
  deviceType: string;
  /** ISO-8601. */
  lastActive: string;
  /** ISO-8601. */
  createdAt: string;
  isCurrent: boolean;
}

/** Security information for the signed-in account (`GET /devices/security`). */
export interface SecurityInfo {
  recoveryEmail: string | null;
}


/**
 * The server's `401 account_not_on_device` for a PINNED mint: the requested
 * `accountId` is not (or is no longer) a live account of this device session.
 *
 * Distinguished from every other mint 401 because the remedy is different: the
 * device secret is FINE — it is the identity binding that went stale (the
 * account was signed out on this device, or revoked). An identity-bound caller
 * must re-establish its session from the local key rather than drop/clear the
 * device credential.
 */
export class AccountNotOnDeviceError extends Error {
  override readonly name = 'AccountNotOnDeviceError';
  /** HTTP status of the originating response; mirrors the ApiError shape. */
  readonly status = 401;
  constructor(readonly accountId: string, readonly cause?: unknown) {
    super(
      `account_not_on_device: ${accountId} is not a live account of this device session`,
    );
  }
}

/**
 * Structural (never `instanceof`) read of a normalized mint error: the thrown
 * value may be a plain ApiError-shaped object or come from another realm.
 */
function isAccountNotOnDevice(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const { status, message } = error as { status?: unknown; message?: unknown };
  if (status !== 401) {
    return false;
  }
  return typeof message === 'string' && message.includes('account_not_on_device');
}


/**
 * The bridge calls share their transport rules with the mint: no bearer
 * (`skipAuth`, so a 401 surfaces directly), one attempt, and never parked
 * behind the request queue.
 */
async function bridgeRequest<T>(
  ctx: OxyContext,
  url: string,
  body: object,
  schema: Parameters<typeof safeParseContract<T>>[0],
): Promise<T> {
  const res = await ctx.request<unknown>('POST', url, body, {
    cache: false,
    skipAuth: true,
    retry: false,
    bypassQueue: true,
  });
  const parsed = safeParseContract(schema, res);
  if (!parsed) {
    throw new Error(`${url.slice(1)} returned an unexpected response shape`);
  }
  return parsed;
}

export class DevicesApi {
  constructor(private readonly ctx: OxyContext) {}

  /**
   * Get all devices for the current user
   * @returns Array of user devices
   */
  async list(): Promise<UserDevice[]> {
    return this.ctx.request<UserDevice[]>('GET', '/devices', undefined, {
      cache: false, // Don't cache device list - always get fresh data
    });
  }

  /**
   * Remove a device
   * @param deviceId - The device ID to remove
   */
  async remove(deviceId: string): Promise<void> {
    await this.ctx.request('DELETE', `/devices/${deviceId}`, undefined, { cache: false });
  }

  /**
   * Get device sessions for a given session ID
   * Note: Not cached by default to ensure fresh data
   * @param sessionId - The session ID
   * @returns Array of device sessions
   */
  async sessions(sessionId: string): Promise<DeviceLinkedSession[]> {
    // Cache disabled by default to ensure fresh session data
    return this.ctx.request<DeviceLinkedSession[]>('GET', `/session/device/sessions/${sessionId}`, undefined, {
      cache: false, // Don't cache sessions - always get fresh data
      deduplicate: true, // Deduplicate concurrent requests for same sessionId
    });
  }

  /**
   * Logout all device sessions
   * @param sessionId - The session ID
   * @param deviceId - Optional device ID to target
   * @param excludeCurrent - Whether to exclude the current session
   * @returns Logout result
   */
  async logoutAll(sessionId: string, deviceId?: string, excludeCurrent?: boolean): Promise<DeviceLinkedSessionLogoutResponse> {
    const urlParams: Record<string, string> = {};
    if (deviceId) urlParams.deviceId = deviceId;
    if (excludeCurrent) urlParams.excludeCurrent = 'true';
    return this.ctx.request<DeviceLinkedSessionLogoutResponse>('POST', `/session/device/logout-all/${sessionId}`, urlParams, { cache: false });
  }

  /**
   * Update device name
   * @param sessionId - The session ID
   * @param deviceName - New device name
   * @returns Updated device object
   */
  async rename(sessionId: string, deviceName: string): Promise<{ success: boolean; message: string; deviceName: string }> {
    return this.ctx.request('PUT', `/session/device/name/${sessionId}`, { deviceName }, { cache: false });
  }

  /**
   * Get security information
   * @returns Security information object
   */
  async securityInfo(): Promise<SecurityInfo> {
    return this.ctx.request<SecurityInfo>('GET', '/devices/security', undefined, {
      cache: false,
    });
  }

  /**
   * Get user's security activity with pagination
   * @param limit - Number of results (default: 50, max: 100)
   * @param offset - Pagination offset (default: 0)
   * @param eventType - Optional filter by event type
   * @returns Security activity response with pagination
   */
  async securityActivity(
    limit?: number,
    offset?: number,
    eventType?: SecurityEventType
  ): Promise<SecurityActivityResponse> {
    const params: Record<string, unknown> = {};
    if (limit !== undefined) params.limit = limit;
    if (offset !== undefined) params.offset = offset;
    if (eventType) params.eventType = eventType;

    // The API responds with the standard paginated envelope:
    //   { data: SecurityActivity[], pagination: { total, limit, offset, hasMore } }
    // SecurityActivityResponse is the flattened shape consumers expect.
    const raw = await this.ctx.request<{
      data: SecurityActivity[];
      pagination: { total: number; limit: number; offset: number; hasMore: boolean };
    }>('GET', '/security/activity', params, { cache: false });

    const requestedLimit = typeof params.limit === 'number' ? params.limit : 0;
    const requestedOffset = typeof params.offset === 'number' ? params.offset : 0;

    return {
      data: raw.data ?? [],
      total: raw.pagination?.total ?? raw.data?.length ?? 0,
      limit: raw.pagination?.limit ?? requestedLimit,
      offset: raw.pagination?.offset ?? requestedOffset,
      hasMore: raw.pagination?.hasMore ?? false,
    };
  }

  /**
   * Log private key exported event
   * @param deviceId - Optional device ID for tracking
   * @returns Promise that resolves when event is logged
   */
  async logPrivateKeyExported(deviceId?: string): Promise<void> {
    try {
      await this.ctx.request<{ success: boolean }>(
        'POST',
        '/security/activity/private-key-exported',
        { deviceId },
        { cache: false }
      );
    } catch (error) {
      // Don't throw - logging failures shouldn't break user flow, but surface
      // for monitoring via the shared logger sink.
      logger.warn('[OxyServices] Failed to log private key exported event', { component: 'oxy.devices' }, error);
    }
  }

  /**
   * Log backup created event
   * @param deviceId - Optional device ID for tracking
   * @returns Promise that resolves when event is logged
   */
  async logBackupCreated(deviceId?: string): Promise<void> {
    try {
      await this.ctx.request<{ success: boolean }>(
        'POST',
        '/security/activity/backup-created',
        { deviceId },
        { cache: false }
      );
    } catch (error) {
      // Don't throw - logging failures shouldn't break user flow, but surface
      // for monitoring via the shared logger sink.
      logger.warn('[OxyServices] Failed to log backup created event', { component: 'oxy.devices' }, error);
    }
  }

  /**
   * Zero-cookie mint. Present the first-party `deviceId` + `deviceSecret` to
   * `POST /session/device/token` — NO bearer, NO cookies: possession of the
   * secret IS the device-ownership proof. Returns a fresh short access token
   * for the device's active account plus `nextDeviceSecret` (on mint, the same
   * proven secret echoed back — rotation happens on sign-in, not mint) and
   * the projected device-session `state`.
   *
   * `skipAuth`: this call carries no bearer, so a 401 must surface DIRECTLY —
   * never trigger `HttpService`'s 401→refresh→retry dance. The cold boot / re-
   * mint handler read the 401 body (`invalid_device_secret` vs
   * `no_active_session`) to decide whether to drop the secret and fall back or
   * resolve signed-out.
   *
   * `retry: false`: the mint is a single logical attempt. The proactive
   * token-refresh scheduler and the reactive 401 lane already own backoff and
   * re-arm, so `HttpService`'s inner retry loop here would only multiply the
   * mint's latency on a slow/black-hole network (3 retries × 5s timeout ≈ 20s
   * per lane) with no correctness benefit — it is the dominant term in the cold
   * boot's worst-case time-to-route. A transient failure surfaces once and the
   * scheduler/401 path retries it later.
   *
   * `options.accountId` PINS the mint to one account of the device instead of
   * whichever account is currently active. It exists for identity-bound
   * clients (Commons), whose authenticated user is fixed by a local
   * cryptographic key and must never follow an account switch made by another
   * app on the same device. The server never mutates `activeAccountId` for a
   * pinned mint — the returned `state` still reports the device's true active
   * account — and rejects a non-member/dead account with
   * `401 account_not_on_device`, surfaced here as {@link AccountNotOnDeviceError}.
   *
   * @throws {AccountNotOnDeviceError} when a pinned mint's account is not on the device.
   * @throws if the response does not match {@link deviceTokenMintResponseSchema}.
   */
  async mintToken(
    deviceId: string,
    deviceSecret: string,
    options?: { accountId?: string },
  ): Promise<DeviceTokenMintResponse> {
    const accountId = options?.accountId;
    try {
      const res = await this.ctx.request<unknown>(
        'POST',
        '/session/device/token',
        { deviceId, deviceSecret, ...(accountId ? { accountId } : {}) },
        // `bypassQueue`: this mint is the control-plane call the auth lane
        // depends on — it must run even when every RequestQueue slot is parked
        // awaiting it, or the whole client deadlocks. See RequestOptions.bypassQueue.
        { cache: false, skipAuth: true, retry: false, bypassQueue: true },
      );
      const parsed = safeParseContract(deviceTokenMintResponseSchema, res);
      if (!parsed) {
        throw new Error('session/device/token returned an unexpected response shape');
      }
      return parsed;
    } catch (error) {
      if (accountId && isAccountNotOnDevice(error)) {
        throw new AccountNotOnDeviceError(accountId, error);
      }
      throw error;
    }
  }

  /**
   * `POST /session/device/register` — auth.oxy.so only. A new, empty browser
   * device with a server-chosen id and auth.oxy.so's holder credential. No
   * bearer: this runs before anyone is signed in.
   *
   * @throws if the response does not match {@link deviceRegisterResponseSchema}.
   */
  async registerBrowser(): Promise<DeviceRegisterResponse> {
    return bridgeRequest(this.ctx, '/session/device/register', {}, deviceRegisterResponseSchema);
  }

  /**
   * `POST /session/device/join-code` — auth.oxy.so only (the bridge page).
   * Proves the device with its holder secret and returns a one-use, ~60 s
   * code for an OFFICIAL app, bound to its exact registered redirect URI and
   * its PKCE S256 challenge. A rejected secret surfaces as a 401 whose message
   * carries `invalid_device_secret`.
   */
  async requestJoinCode(request: DeviceJoinCodeRequest): Promise<DeviceJoinCodeResponse> {
    return bridgeRequest(this.ctx, '/session/device/join-code', request, deviceJoinCodeResponseSchema);
  }

  /**
   * `POST /session/device/join` — the app's own origin. Redeems the bridge's
   * code with the PKCE verifier this app holds, and returns this app's own
   * holder credential for the browser's device. Persist it, then mint through
   * {@link DevicesApi.mintToken} like any other holder.
   */
  async joinBrowser(request: DeviceJoinRequest): Promise<DeviceJoinResponse> {
    return bridgeRequest(this.ctx, '/session/device/join', request, deviceJoinResponseSchema);
  }

  /**
   * Provision a NON-rotating background credential for the caller's account on
   * this device — the credential native background code (an Android widget
   * worker, which runs with no JS runtime) presents to mint its own access
   * tokens without any JS involvement.
   *
   * It exists precisely so background code never touches the device secret:
   * `POST /session/device/token` ROTATES that secret on every mint (the
   * presented one stays valid only for a short grace), so a worker minting
   * from it would become a second writer of the value JS depends on and could
   * silently sign the user out. The background credential is a separate,
   * non-rotating value minted server-side, so the two lanes never contend.
   *
   * Bearer required and NO body: the server derives both the `deviceId` and
   * the account from the validated bearer. This is the only way a background
   * credential comes into existence, so background code can EXTEND a session
   * the user established in-app but can never bootstrap one from nothing.
   *
   * Unlike the mint above this is NOT a control-plane call — it runs while a
   * session is already live — so it takes the normal authenticated path: no
   * `skipAuth` (a 401 should go through the ordinary re-mint lane) and no
   * `bypassQueue` (nothing in the auth lane is parked awaiting it).
   *
   * There is deliberately no JS counterpart that MINTS from the returned
   * credential: the native side owns that call, and a symmetric-looking JS
   * method would be dead code plus a second implementation of the failure
   * rules. The asymmetry is the design.
   *
   * **Call this from NATIVE only.** There is no background worker on web to
   * consume the credential, and handing a browser origin a long-lived
   * non-rotating secret to persist is strictly weaker than the rotating device
   * secret it already holds. The 404 degrade below is also native-shaped: a
   * browser attaches `Origin`, which a server predating this route answers
   * `403 BAD_ORIGIN` from its router-wide same-site guard rather than 404, so
   * the quiet degrade would not fire there. A native client sends no `Origin`
   * and gets the 404. Gate the caller by platform; do not widen the degrade to
   * 403, which would also swallow a genuine origin misconfiguration.
   *
   * That paragraph is LOAD-BEARING, not belt-and-braces: the route sits above
   * oxy-api's router-wide origin guard (deliberately, so a native client with
   * no `Origin` is not rejected). oxy-api additionally refuses callers that
   * carry browser context signals (`Origin` or `Sec-Fetch-Site`) with
   * `403 browser_not_allowed` — native HTTP clients send neither. Gate the
   * caller by platform on the client as well; do not widen the 404 degrade to
   * 403, which would also swallow a genuine origin misconfiguration.
   *
   * @returns the provisioned credential, or `null` when the endpoint is absent
   * (404). The API deploy leads the SDK release, so a client on a newer SDK
   * than the server degrades to "no background session" quietly instead of
   * surfacing an error.
   * @throws if the response does not match {@link deviceBackgroundCredentialResponseSchema}.
   */
  async provisionBackgroundCredential(): Promise<DeviceBackgroundCredentialResponse | null> {
    try {
      const res = await this.ctx.request<unknown>(
        'POST',
        '/session/device/background-credential',
        undefined,
        { cache: false },
      );
      const parsed = safeParseContract(deviceBackgroundCredentialResponseSchema, res);
      if (!parsed) {
        throw new Error(
          'session/device/background-credential returned an unexpected response shape',
        );
      }
      return parsed;
    } catch (error) {
      if (extractErrorStatus(error) === 404) {
        return null;
      }
      throw error;
    }
  }

}
