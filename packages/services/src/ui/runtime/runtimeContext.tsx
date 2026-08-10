import { createContext, useContext } from 'react';
import type { DeviceDirectory } from '@oxyhq/contracts';
import type { DeviceContext, User } from '@oxyhq/core';
import type { OxyRuntime } from './createOxyRuntime';
import type { OxyRuntimeStatus } from './types';
import { useRuntimeSelector, useRuntimeSnapshot } from './useRuntimeSnapshot';

/**
 * The runtime reference itself, as a context value that NEVER changes identity
 * (ADR 0004).
 *
 * It is deliberately a second context beside the big `OxyContextState` one.
 * That value is rebuilt whenever any of its fifty-odd members moves — a locale,
 * a dialog opening — and every hook reading it re-renders with it. Hooks
 * hanging off this one subscribe to the runtime with a selector instead, so
 * only a change to what they actually selected wakes them. Retiring the wide
 * context is Phase 8; this is what its replacements are built on.
 */
const OxyRuntimeHandleContext = createContext<OxyRuntime | null>(null);

export const OxyRuntimeHandleProvider = OxyRuntimeHandleContext.Provider;

const RUNTIME_MISSING_MESSAGE =
  'useOxyRuntime() was called outside <OxyProvider>. Mount <OxyProvider clientId="…"> above this component.';

export class OxyRuntimeMissingError extends Error {
  readonly code = 'oxy_runtime_missing';

  constructor() {
    super(RUNTIME_MISSING_MESSAGE);
    this.name = 'OxyRuntimeMissingError';
  }
}

/** The runtime this provider owns. THROWS when no `<OxyProvider>` is mounted. */
export function useOxyRuntime(): OxyRuntime {
  const runtime = useContext(OxyRuntimeHandleContext);
  if (runtime === null) {
    throw new OxyRuntimeMissingError();
  }
  return runtime;
}

export interface ActiveAccount {
  /**
   * The human whose authentication backs the session — the audit actor. Equal
   * to {@link ActiveAccount.account} unless a delegated context is active.
   */
  principal: User | null;
  /** The account the session acts AS — what a profile header renders. */
  account: User | null;
  /** The resolved `principal acting as account` pair, when a directory is held. */
  context: DeviceContext | null;
  /** Whether the actor and the subject are different accounts. */
  isDelegated: boolean;
  status: OxyRuntimeStatus;
}

function selectActiveAccount(snapshot: {
  principal: User | null;
  account: User | null;
  activeContext: DeviceContext | null;
  status: OxyRuntimeStatus;
}): ActiveAccount {
  return {
    principal: snapshot.principal,
    account: snapshot.account,
    context: snapshot.activeContext,
    isDelegated: snapshot.activeContext?.isDelegated ?? false,
    status: snapshot.status,
  };
}

function activeAccountsEqual(a: ActiveAccount, b: ActiveAccount): boolean {
  return (
    a.principal === b.principal &&
    a.account === b.account &&
    a.context === b.context &&
    a.isDelegated === b.isDelegated &&
    a.status === b.status
  );
}

/**
 * Who this app is running as, with the actor and the subject kept apart.
 *
 * Unlike `useOxy()`, this re-renders only when one of those five facts moves —
 * a locale change, a dialog opening or a session-list refresh does not reach it.
 */
export function useActiveAccount(): ActiveAccount {
  return useRuntimeSelector(useOxyRuntime(), selectActiveAccount, activeAccountsEqual);
}

const selectDirectory = (snapshot: { device: DeviceDirectory | null }): DeviceDirectory | null =>
  snapshot.device;

/**
 * The device directory — every principal on this device and the contexts each
 * may act as (ADR 0002).
 *
 * `null` until something calls `runtime.refreshDirectory()`. A client that
 * never asks for one never pays for the round trip.
 */
export function useDeviceDirectory(): DeviceDirectory | null {
  return useRuntimeSelector(useOxyRuntime(), selectDirectory);
}

/** The whole runtime snapshot. Prefer a narrower hook where one exists. */
export function useOxySnapshot(): ReturnType<OxyRuntime['getSnapshot']> {
  return useRuntimeSnapshot(useOxyRuntime());
}
