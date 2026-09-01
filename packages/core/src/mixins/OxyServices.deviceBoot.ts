/**
 * Device-first token mint mixin.
 *
 * The client half of the zero-cookie device transport: the single network call
 * the cold boot (`sessionColdBoot`) and the unified re-mint handler (`refresh.ts`)
 * make to turn a first-party `deviceId` + `deviceSecret` into a fresh access
 * token. The response is validated against the `@oxyhq/contracts`
 * `deviceTokenMintResponseSchema`, so producer (oxy-api) and consumer cannot
 * drift — an unexpected shape throws here rather than silently corrupting the
 * persisted store.
 *
 * This method carries NO persistence or token-planting side effects of its own;
 * the cold boot / re-mint handler own persistence and `setTokens`, so the same
 * primitive can be reused from either without double-planting.
 *
 * `provisionBackgroundCredential` is the mixin's second, adjacent call: it hands
 * native background code (no JS runtime) its own non-rotating credential so that
 * code never has to mint from — and therefore never rotates — the device secret
 * JS depends on.
 */
import {
  deviceBackgroundCredentialResponseSchema,
  deviceTokenMintResponseSchema,
  safeParseContract,
  type DeviceBackgroundCredentialResponse,
  type DeviceTokenMintResponse,
} from '@oxyhq/contracts';
import type { OxyServicesBase } from '../OxyServices.base';
import { extractErrorStatus } from '../utils/errorUtils';

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

export function OxyServicesDeviceBootMixin<T extends typeof OxyServicesBase>(Base: T) {
  return class extends Base {
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
    async mintFromDeviceSecret(
      deviceId: string,
      deviceSecret: string,
      options?: { accountId?: string },
    ): Promise<DeviceTokenMintResponse> {
      const accountId = options?.accountId;
      try {
        const res = await this.makeRequest<unknown>(
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
        const normalized = this.handleError(error);
        if (accountId && isAccountNotOnDevice(normalized)) {
          throw new AccountNotOnDeviceError(accountId, normalized);
        }
        throw normalized;
      }
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
     * surfacing an error. The status is read off the RAW rejection because
     * `handleError` only preserves it for errors carrying `HttpService`'s
     * annotations.
     * @throws if the response does not match {@link deviceBackgroundCredentialResponseSchema}.
     */
    async provisionBackgroundCredential(): Promise<DeviceBackgroundCredentialResponse | null> {
      try {
        const res = await this.makeRequest<unknown>(
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
        throw this.handleError(error);
      }
    }
  };
}
