import { logger, type OxyServices, type TokenTransport } from '@oxy.so/core';
import type { DeviceSessionState } from '@oxy.so/contracts';

/**
 * Platform `TokenTransport` for `SessionClient` (device-first model).
 *
 * `ensureActiveToken` is the fallback the client uses when a `session_state`
 * push arrived WITHOUT an embedded `activeToken` and the planted bearer does not
 * already belong to the state's active account. It mints one through the ONE
 * unified single-flight the scheduler, the request-time preflight, and the 401
 * retry all use — `oxyServices.httpService.refreshAccessToken(...)` — which runs
 * the installed refresh handler (present the persisted zero-cookie `deviceId` +
 * `deviceSecret` at `POST /session/device/token`, which mints for the device's
 * CURRENT active account). Routing through the SAME entry point means this lane
 * can never double-rotate the device secret against the others: it has NO
 * private single-flight of its own.
 *
 * The short-circuit compares the planted bearer's ACCOUNT against
 * `state.activeAccountId`, not mere token presence: a bearer for the PREVIOUS
 * account (an account switch) must still mint the new account's token — skipping
 * on presence alone would leave a subscriber observing the new active account
 * under the old account's bearer (the account-switch 404 race).
 *
 * A failure is logged and swallowed: this method must never throw out (it runs
 * inside the socket state handler).
 *
 * `getPinnedAccountId` is the identity-bound escape hatch. Converging the bearer
 * on `state.activeAccountId` is precisely what an identity-bound client must
 * never do — its token is minted for the PINNED account by the cold boot /
 * re-mint lane. `SessionClient` already bypasses the transport entirely while
 * pinned; this guard is the services-side half of that contract, so no future
 * wiring can reintroduce the convergence from this end.
 */
export function createTokenTransport(
  oxyServices: OxyServices,
  getPinnedAccountId?: () => string | null,
): TokenTransport {
  return {
    async ensureActiveToken(state: DeviceSessionState): Promise<void> {
      if ((getPinnedAccountId?.() ?? null) !== null) {
        return;
      }
      try {
        // Skip the mint ONLY when the planted bearer already identifies the
        // active account. `getCurrentUserId()` decodes the bearer's `userId`/`id`
        // (null when absent/opaque), directly comparable to the account id.
        const activeAccountId = state.activeAccountId;
        if (activeAccountId !== null && oxyServices.getCurrentUserId() === activeAccountId) {
          return;
        }
      } catch (error) {
        logger.warn('ensureActiveToken: bearer-account check threw', { component: 'TokenTransport' }, error);
      }

      try {
        // The shared HttpService single-flight coalesces concurrent callers onto
        // one in-flight mint; no local `inFlightMint` guard is needed.
        const token = await oxyServices.httpService.refreshAccessToken('preflight');
        if (!token) {
          logger.debug('ensureActiveToken: refresh produced no session', {
            component: 'TokenTransport',
            deviceId: state.deviceId,
          });
        }
      } catch (error) {
        logger.warn('ensureActiveToken: refresh failed', { component: 'TokenTransport' }, error);
      }
    },
  };
}
