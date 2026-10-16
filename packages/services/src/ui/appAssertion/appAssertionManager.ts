/**
 * The app's assertion of which app it is (ADR 0045), obtained and refreshed for
 * the signed-in session without any app code.
 *
 * One manager per `OxyProvider`. For the active session it resolves the app's
 * application id from its registered `clientId`, proves the app by platform —
 * the browser's `Origin` on the web, Play Integrity on Android, App Attest on
 * iOS — trades the proof for an Oxy-signed `OXY-APP+JWT`, and refreshes it a
 * minute before it expires. A session change drops the assertion at once: an
 * assertion names exactly one person and one session.
 *
 * Outcomes are values, never thrown: `ready`, `unsupported` (this build cannot
 * prove itself: no `clientId`, no native module, App Attest unavailable) or
 * `unavailable` (Oxy refused or could not be reached). A refusal that will not
 * change for this session (an unregistered origin or platform) is not retried
 * until the session changes; anything else is retried with a backoff.
 */

import type { AppAssertionPlatform, AppAssertionResponse } from '@oxy.so/contracts';
import { OXY_APP_ASSERTION_HEADER } from '@oxy.so/contracts/client';
import type { OxyServices } from '@oxy.so/core';
import type { StorageInterface } from '../utils/storageHelpers';
import type { AppIntegrityModule, AppIntegrityPlatform } from './appIntegrityTypes';

export type AppAssertionStatus = 'idle' | 'pending' | 'ready' | 'unavailable' | 'unsupported';

export interface AppAssertionSnapshot {
  readonly status: AppAssertionStatus;
  /** The `OXY-APP+JWT`, to send as `X-Oxy-App-Assertion`. */
  readonly assertion: string | null;
  readonly applicationId: string | null;
  readonly platform: AppAssertionPlatform | null;
  /** Epoch milliseconds. */
  readonly expiresAt: number | null;
  /** Why there is none: an `APP_ASSERTION_ERROR_CODES` value, or an SDK reason. */
  readonly error: string | null;
}

export interface AppAssertionSession {
  readonly userId: string;
  readonly sessionId: string;
}

export interface AppAssertionManagerOptions {
  readonly oxyServices: Pick<OxyServices, 'apps'>;
  readonly clientId: string | null;
  readonly integrity: AppIntegrityPlatform;
  /** Where an iOS install keeps its App Attest key id. */
  readonly storage: () => StorageInterface | null;
  readonly storageKeyPrefix: string;
  readonly now?: () => number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

/** Refresh this long before expiry. */
const REFRESH_BEFORE_MS = 60_000;
/** `getAppAssertion()` fetches anew when less than this is left. */
const MIN_REMAINING_MS = 30_000;
const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;

/** Refusals that will not change for this session. */
const PERMANENT_REFUSALS = new Set([
  'application_unavailable',
  'session_other_application',
  'platform_not_registered',
  'origin_not_registered',
  'integrity_unconfigured',
]);

const IDLE: AppAssertionSnapshot = {
  status: 'idle',
  assertion: null,
  applicationId: null,
  platform: null,
  expiresAt: null,
  error: null,
};

class Unsupported extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Unsupported) return error.reason;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'request_failed';
}

export class AppAssertionManager {
  private snapshot: AppAssertionSnapshot = IDLE;
  private readonly listeners = new Set<() => void>();
  private session: AppAssertionSession | null = null;
  /** Bumped on every session change; a result for an older generation is dropped. */
  private generation = 0;
  private inflight: Promise<string | null> | null = null;
  private timer: unknown = null;
  private retryMs = RETRY_FIRST_MS;
  private retryAt = 0;
  private applicationId: { clientId: string; id: Promise<string> } | null = null;
  private preparedProject: string | null = null;
  private readonly now: () => number;
  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  constructor(private readonly options: AppAssertionManagerOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    this.clearTimer =
      options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): AppAssertionSnapshot => this.snapshot;

  /**
   * A current assertion for the active session, obtaining one when there is
   * none or it is about to expire; `null` when this app cannot have one now.
   */
  readonly getAppAssertion = async (): Promise<string | null> => {
    const current = this.snapshot;
    if (
      current.status === 'ready' &&
      current.assertion &&
      current.expiresAt !== null &&
      current.expiresAt - this.now() > MIN_REMAINING_MS
    ) {
      return current.assertion;
    }
    if (!this.session || current.status === 'unsupported') return null;
    if (current.status === 'unavailable' && this.now() < this.retryAt) return null;
    return this.refresh();
  };

  /**
   * `{ 'X-Oxy-App-Assertion': <assertion> }` for a request to a service that
   * needs to know the app (Alia), or `{}` when there is none.
   */
  readonly getAppAssertionHeaders = async (): Promise<Record<string, string>> => {
    const assertion = await this.getAppAssertion();
    return assertion ? { [OXY_APP_ASSERTION_HEADER]: assertion } : {};
  };

  /** Follow the active session; `null` when signed out or not yet able to call Oxy. */
  setSession(session: AppAssertionSession | null): void {
    const same =
      session?.userId === this.session?.userId && session?.sessionId === this.session?.sessionId;
    if (same) return;
    this.session = session;
    this.generation += 1;
    this.inflight = null;
    this.retryMs = RETRY_FIRST_MS;
    this.retryAt = 0;
    this.cancelTimer();
    this.publish(IDLE);
    if (session) void this.refresh();
  }

  /** Stop all work. A later `setSession` starts again. */
  dispose(): void {
    this.session = null;
    this.generation += 1;
    this.inflight = null;
    this.cancelTimer();
  }

  private refresh(): Promise<string | null> {
    if (this.inflight) return this.inflight;
    const generation = this.generation;
    const run = this.obtain()
      .then((answer) => {
        if (generation !== this.generation) return null;
        const expiresAt = Date.parse(answer.expiresAt);
        this.retryMs = RETRY_FIRST_MS;
        this.publish({
          status: 'ready',
          assertion: answer.assertion,
          applicationId: answer.applicationId,
          platform: answer.platform,
          expiresAt,
          error: null,
        });
        this.schedule(Math.max(expiresAt - this.now() - REFRESH_BEFORE_MS, MIN_REMAINING_MS));
        return answer.assertion;
      })
      .catch((error: unknown) => {
        if (generation !== this.generation) return null;
        const code = errorCode(error);
        const unsupported = error instanceof Unsupported;
        const current = this.snapshot;
        if (
          !unsupported &&
          !PERMANENT_REFUSALS.has(code) &&
          current.status === 'ready' &&
          current.expiresAt !== null &&
          current.expiresAt - this.now() > MIN_REMAINING_MS
        ) {
          // The assertion in hand is still good: keep it, and try again soon.
          this.schedule(
            Math.min(RETRY_FIRST_MS, current.expiresAt - this.now() - MIN_REMAINING_MS),
          );
          return current.assertion;
        }
        this.publish({
          ...IDLE,
          status: unsupported ? 'unsupported' : 'unavailable',
          platform: this.options.integrity.platform,
          error: code,
        });
        if (!unsupported) {
          if (PERMANENT_REFUSALS.has(code)) {
            this.retryAt = Number.POSITIVE_INFINITY;
          } else {
            this.retryAt = this.now() + this.retryMs;
            this.schedule(this.retryMs);
            this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
          }
        }
        return null;
      })
      .finally(() => {
        if (this.inflight === run) this.inflight = null;
      });
    this.inflight = run;
    if (this.snapshot.status !== 'ready') this.publish({ ...this.snapshot, status: 'pending' });
    return run;
  }

  private async obtain(): Promise<AppAssertionResponse> {
    const applicationId = await this.resolveApplicationId();
    const { platform } = this.options.integrity;
    const assertions = this.options.oxyServices.apps.assertions;
    if (platform === 'web') return assertions.create({ applicationId, platform: 'web' });

    const integrity = await this.options.integrity.loadIntegrity();
    if (!integrity) throw new Unsupported('integrity_module_unavailable');
    if (platform === 'android') return this.proveAndroid(applicationId, integrity);
    if (!integrity.isSupported) throw new Unsupported('app_attest_unsupported');
    return this.proveIos(applicationId, integrity);
  }

  private resolveApplicationId(): Promise<string> {
    const clientId = this.options.clientId;
    if (!clientId) return Promise.reject(new Unsupported('client_id_missing'));
    if (this.applicationId?.clientId !== clientId) {
      const id = this.options.oxyServices.apps.getPublic(clientId).then((app) => app.id);
      id.catch(() => {
        if (this.applicationId?.id === id) this.applicationId = null;
      });
      this.applicationId = { clientId, id };
    }
    return this.applicationId.id;
  }

  private async proveAndroid(
    applicationId: string,
    integrity: AppIntegrityModule,
  ): Promise<AppAssertionResponse> {
    const assertions = this.options.oxyServices.apps.assertions;
    const challenge = await assertions.challenge({ applicationId, platform: 'android' });
    if (!challenge.cloudProjectNumber) throw new Unsupported('integrity_unconfigured');
    try {
      if (this.preparedProject !== challenge.cloudProjectNumber) {
        await integrity.prepareIntegrityTokenProviderAsync(challenge.cloudProjectNumber);
        this.preparedProject = challenge.cloudProjectNumber;
      }
      const integrityToken = await integrity.requestIntegrityCheckAsync(challenge.requestHash);
      return await assertions.create({
        applicationId,
        platform: 'android',
        proof: { challenge: challenge.challenge, integrityToken },
      });
    } catch (error) {
      // A provider Google invalidated is prepared again on the next attempt.
      this.preparedProject = null;
      throw error;
    }
  }

  private async proveIos(
    applicationId: string,
    integrity: AppIntegrityModule,
  ): Promise<AppAssertionResponse> {
    const keyName = `${this.options.storageKeyPrefix}_app_attest_key_${applicationId}`;
    const storage = this.options.storage();
    const assertOnce = async (keyId: string) => {
      const assertions = this.options.oxyServices.apps.assertions;
      const challenge = await assertions.challenge({
        applicationId,
        platform: 'ios',
        purpose: 'assertion',
      });
      const assertion = await integrity.generateAssertionAsync(keyId, challenge.requestHash);
      return assertions.create({
        applicationId,
        platform: 'ios',
        proof: { challenge: challenge.challenge, keyId, assertion },
      });
    };

    const stored = await storage?.getItem(keyName).catch(() => null);
    if (stored) {
      try {
        return await assertOnce(stored);
      } catch (error) {
        // Oxy no longer knows the key (swept, or never registered): attest a new one.
        if (errorCode(error) !== 'attest_key_unknown') throw error;
        await storage?.removeItem(keyName).catch(() => undefined);
      }
    }
    const keyId = await this.attestKey(applicationId, integrity);
    await storage?.setItem(keyName, keyId).catch(() => undefined);
    return assertOnce(keyId);
  }

  private async attestKey(applicationId: string, integrity: AppIntegrityModule): Promise<string> {
    const assertions = this.options.oxyServices.apps.assertions;
    const keyId = await integrity.generateKeyAsync();
    const challenge = await assertions.challenge({
      applicationId,
      platform: 'ios',
      purpose: 'attest_key',
    });
    const attestation = await integrity.attestKeyAsync(keyId, challenge.requestHash);
    await assertions.registerAttestKey({
      applicationId,
      keyId,
      challenge: challenge.challenge,
      attestation,
    });
    return keyId;
  }

  private schedule(ms: number): void {
    this.cancelTimer();
    const generation = this.generation;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (generation === this.generation && this.session) void this.refresh();
    }, ms);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private publish(next: AppAssertionSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
