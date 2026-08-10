import type { DeviceDirectory, DeviceSessionState } from '@oxyhq/contracts';
import type { ClientSession, DeviceContext, User } from '@oxyhq/core';

/**
 * The runtime's coarse verdict about this device's session.
 *
 * `'booting'` is NOT "signed out but we are still looking": it is the honest
 * "undetermined" that every readiness gate in the SDK exists to express, and it
 * ends exactly once at the first cold-boot resolution. `'error'` is reserved for
 * a resolved boot that produced no account AND recorded a failure — a failed
 * sign-in against a signed-out device is `'signed_out'` with an `error`, because
 * the device really is signed out.
 */
export type OxyRuntimeStatus = 'booting' | 'authenticated' | 'signed_out' | 'error';

/**
 * Whether a bearer usable for private calls is planted right now.
 *
 * `'refreshing'` covers both halves of the gap the SDK already tracked with two
 * separate booleans: a bearer that is present but whose readiness gate is shut
 * (a commit in flight), and an authenticated account whose bearer has been
 * invalidated and is being re-minted. Both mean the same thing to a caller —
 * wait, do not treat this as signed out.
 */
export type OxyTokenStatus = 'missing' | 'refreshing' | 'ready' | 'error';

export interface OxyRuntimeError {
  message: string;
  code: string;
}

/**
 * The ONE observable state of an `OxyRuntime` (ADR 0004).
 *
 * Frozen and referentially stable: a new object is published only when
 * something actually changed, so `useSyncExternalStore` can compare by identity
 * and a selector over an unchanged field never re-renders.
 *
 * Every field is either a fact the runtime owns or a pure derivation of one.
 * There is no second writable store: `sessions`, `activeSessionId`, `status`
 * and `tokenStatus` are computed by the one snapshot builder, so two of them can
 * never disagree about the same device.
 */
export interface OxyRuntimeSnapshot {
  status: OxyRuntimeStatus;

  /**
   * The device DIRECTORY (ADR 0002) — principals and the contexts each may act
   * as. `null` until something asks for one; the flat lane never pays for it.
   */
  device: DeviceDirectory | null;

  /**
   * The flat, server-authoritative device state. Kept beside {@link device}
   * because it is what the compatibility projections below are derived from,
   * and because the two describe the same device at the same `revision`.
   */
  deviceState: DeviceSessionState | null;

  /** The active `principal acting as account` pair, when a directory is held. */
  activeContext: DeviceContext | null;

  /**
   * The human whose authentication backs the session — the audit actor.
   *
   * Equal to {@link account} on a device with no directory and on any
   * non-delegated context: the flat lane cannot tell the two apart, and saying
   * so by making them the same object is more honest than leaving this `null`.
   */
  principal: User | null;

  /** The account the session acts AS — what a profile header renders. */
  account: User | null;

  tokenStatus: OxyTokenStatus;

  /**
   * Whether the first cold boot has concluded. Monotonic: once `true` it never
   * reverts, so a later transient signed-out state is never mistaken for
   * "still booting".
   */
  authResolved: boolean;

  /** A context activation / account switch is in flight. */
  switching: boolean;

  error: OxyRuntimeError | null;

  // ── Compatibility projections ────────────────────────────────────────────
  // Derived, never separately written. They exist because every app still
  // renders the flat session list; Phase 7 moves them onto the directory.

  sessions: ClientSession[];
  activeSessionId: string | null;

  /** A sign-in / sign-out operation is in flight. */
  isLoading: boolean;

  /** The local display/bookkeeping storage has resolved. */
  storageReady: boolean;

  /** A bearer is planted on the client instance right now. */
  hasAccessToken: boolean;

  /**
   * The commit gate. Shut while a session commit is mid-flight so a consumer
   * cannot fire a private call between the token landing and the projection.
   */
  tokenReady: boolean;
}
