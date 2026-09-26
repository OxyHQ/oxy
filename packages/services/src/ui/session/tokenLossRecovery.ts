/**
 * What a signed-in app does when its access token disappears at runtime.
 *
 * `HttpService` clears the bearer when a request draws a 401 and the refresh it
 * then tries returns nothing. That refresh can return nothing for reasons that
 * say NOTHING about the session: the mint is cooling down after a failure or a
 * 429, the network dropped, the server was restarting. The provider used to read
 * every such clear as a sign-out and tore the session down on the spot — and
 * because the proactive refresh scheduler only runs while a token exists, nothing
 * was left to bring the session back. Only a relaunch did, because the cold boot
 * mints from the durable device credential that had been there all along
 * (OxyHQ/Mention#1140).
 *
 * So a lost token is a question, and this answers it the way a relaunch would:
 *
 *  - The durable store still holds the device credential → the session is NOT
 *    known to be over. Keep the user signed in (private queries pause, because
 *    there is no bearer) and re-mint with backoff until one succeeds. A
 *    definitive server verdict (`invalid_device_secret`, `no_active_session`)
 *    makes the refresh handler drop or clear that credential, which is what ends
 *    this loop in a sign-out — so a real revocation still signs out.
 *  - No credential, but a key-based lane can still re-establish (the native
 *    shared identity, or an identity-bound client's own key) → try that a few
 *    times, as the cold boot's shared-key step would, then sign out.
 *  - Neither → the session is over. Sign out now, as before.
 *
 * Framework-free and clock-injectable so the policy is unit tested without a
 * provider.
 */
import { logger } from '@oxy.so/core';

export interface TokenLossRecoveryDeps {
  /** Re-mint once through the installed refresh handler; the token, or null. */
  remint: () => Promise<string | null>;
  /** Whether the durable auth store still holds `deviceId` + `deviceSecret`. */
  hasDeviceCredential: () => Promise<boolean>;
  /**
   * Whether a key-based lane could still re-establish the session without a
   * device secret. Consulted only once the credential is gone.
   */
  hasKeyedRecovery: () => Promise<boolean>;
  /** Whether the UI still shows a signed-in user. */
  isSignedIn: () => boolean;
  /** Whether a bearer is planted right now. */
  hasToken: () => boolean;
  /** Tear down the local session (the provider's `clearSessionState`). */
  signOutLocally: () => Promise<void>;
  /** Timer seam for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface TokenLossRecovery {
  /** Start recovering, unless a recovery is already running. */
  start(): void;
  /** Abandon any running recovery (provider unmount). */
  dispose(): void;
  /** Whether a recovery is running. */
  isRecovering(): boolean;
}

/**
 * Delays between re-mint attempts while the device credential is intact. Starts
 * near the post-failure refresh cooldowns and settles at one attempt a minute,
 * which also respects the mint's own 60s rate-limit cooldown.
 */
export const TOKEN_RECOVERY_BACKOFF_MS: readonly number[] = [2_000, 5_000, 10_000, 20_000, 30_000, 60_000];

/** Attempts through a key-based lane once the device credential is gone. */
export const MAX_KEYED_RECOVERY_ATTEMPTS = 3;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const LOG_CONTEXT = { component: 'OxyContext', method: 'tokenLossRecovery' } as const;

export function createTokenLossRecovery(deps: TokenLossRecoveryDeps): TokenLossRecovery {
  const sleep = deps.sleep ?? defaultSleep;
  let running = false;
  let disposed = false;

  const settled = (): boolean => disposed || deps.hasToken() || !deps.isSignedIn();

  const run = async (): Promise<void> => {
    let attempt = 0;
    let keyedAttempts = 0;
    logger.warn('Access token lost while signed in — recovering the session instead of signing out', LOG_CONTEXT);
    while (!settled()) {
      if (!(await deps.hasDeviceCredential())) {
        const keyed = keyedAttempts < MAX_KEYED_RECOVERY_ATTEMPTS && (await deps.hasKeyedRecovery());
        if (!keyed) {
          if (settled()) {
            return;
          }
          logger.warn('Session recovery ended: no device credential and no key-based lane left — signing out', {
            ...LOG_CONTEXT,
            attempts: attempt,
            keyedAttempts,
          });
          await deps.signOutLocally();
          return;
        }
        keyedAttempts += 1;
      }
      if (settled()) {
        return;
      }
      const token = await deps.remint().catch(() => null);
      attempt += 1;
      if (token || settled()) {
        if (token) {
          logger.warn('Session recovered after a lost access token', { ...LOG_CONTEXT, attempts: attempt });
        }
        return;
      }
      await sleep(TOKEN_RECOVERY_BACKOFF_MS[Math.min(attempt - 1, TOKEN_RECOVERY_BACKOFF_MS.length - 1)]);
    }
  };

  return {
    start(): void {
      if (running || disposed) {
        return;
      }
      running = true;
      void run()
        .catch(async (error: unknown) => {
          // Never leave a signed-in UI with no bearer and nothing recovering it.
          logger.warn('Session recovery failed unexpectedly — signing out', LOG_CONTEXT, error);
          if (!settled()) {
            await deps.signOutLocally().catch(() => undefined);
          }
        })
        .finally(() => {
          running = false;
        });
    },
    dispose(): void {
      disposed = true;
    },
    isRecovering(): boolean {
      return running;
    },
  };
}
