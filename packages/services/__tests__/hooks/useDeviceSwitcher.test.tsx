/**
 * `useDeviceSwitcher` — the thin binding over the shared `AccountDialogController`
 * in `@oxyhq/core`.
 *
 * The grouping itself (`projectDevicePrincipals`) is unit-tested in core; here we
 * assert the RN hook faithfully surfaces the controller's snapshot and forwards
 * the three device operations to it — and, in particular, that it forwards
 * `signOutPrincipal` to the PRINCIPAL call rather than to the context one. Those
 * two are different questions on a device holding two people, and a hook that
 * quietly aliased them would look correct in every single-person fixture.
 */

import { renderHook, act } from '@testing-library/react';
import type { DeviceDirectory } from '@oxyhq/contracts';
import type { AccountDialogSnapshot } from '@oxyhq/core';
import { resolveActiveContext } from '@oxyhq/core';

/** Nate and Alice, both able to act as `org`. */
const sharedDirectory = (activeContextId: string | null): DeviceDirectory => ({
  deviceId: 'device-1',
  revision: 4,
  activeContextId,
  updatedAt: 1_720_000_000_000,
  principals: [
    {
      id: 'p-nate',
      userId: 'nate',
      authuser: 0,
      user: { id: 'nate', username: 'nate' },
      contexts: [
        {
          id: 'ctx-nate',
          accountId: 'nate',
          kind: 'personal',
          relationship: 'self',
          account: { id: 'nate', username: 'nate' },
          onDevice: true,
          available: true,
          active: activeContextId === 'ctx-nate',
          lastUsedAt: null,
        },
        {
          id: 'ctx-nate-org',
          accountId: 'org',
          kind: 'organization',
          relationship: 'owner',
          account: { id: 'org', username: 'oxy' },
          onDevice: true,
          available: true,
          active: activeContextId === 'ctx-nate-org',
          lastUsedAt: null,
        },
      ],
    },
    {
      id: 'p-alice',
      userId: 'alice',
      authuser: 1,
      user: { id: 'alice', username: 'alice' },
      contexts: [
        {
          id: 'ctx-alice-org',
          accountId: 'org',
          kind: 'organization',
          relationship: 'member',
          account: { id: 'org', username: 'oxy' },
          onDevice: false,
          available: true,
          active: activeContextId === 'ctx-alice-org',
          lastUsedAt: null,
        },
      ],
    },
  ],
});

const makeSnapshot = (over?: Partial<AccountDialogSnapshot>): AccountDialogSnapshot => {
  const directory = over?.directory ?? null;
  return {
    view: 'accounts',
    directory,
    activeContext: resolveActiveContext(directory),
    loading: false,
    error: null,
    activatingContextId: null,
    removingContextId: null,
    removingPrincipalId: null,
    signIn: {
      phase: 'idle',
      authorizeCode: null,
      qrPayload: null,
      expiresAt: null,
      error: null,
      route: null,
      routeFailed: false,
      pushSentAt: null,
      openedAt: null,
      progress: 'idle',
    },
    commonsAvailability: 'unknown',
    ...over,
  };
};

let snapshot = makeSnapshot();
const controller = {
  subscribe: (_listener: () => void) => () => undefined,
  getSnapshot: () => snapshot,
  activateContext: jest.fn(async () => true),
  signOutContext: jest.fn(async () => true),
  signOutPrincipal: jest.fn(async () => true),
};
let mockController: typeof controller | null = controller;

jest.mock('../../src/ui/context/OxyContext', () => ({
  __esModule: true,
  useOxy: () => ({
    accountDialogController: mockController,
    oxyServices: { getFileDownloadUrl: (id: string) => `https://cdn/${id}` },
  }),
}));

jest.mock('../../src/ui/hooks/useI18n', () => ({
  __esModule: true,
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US' }),
}));

import { useDeviceSwitcher } from '../../src/ui/hooks/useDeviceSwitcher';

describe('useDeviceSwitcher', () => {
  beforeEach(() => {
    snapshot = makeSnapshot();
    mockController = controller;
    jest.clearAllMocks();
  });

  it('groups the directory by person, keeping both routes to a shared account', () => {
    snapshot = makeSnapshot({ directory: sharedDirectory('ctx-nate') });

    const { result } = renderHook(() => useDeviceSwitcher());

    expect(result.current.principals.map((p) => p.principalId)).toEqual(['p-nate', 'p-alice']);
    // One account, two contexts, under two different humans — the shape a flat
    // list keyed by account id cannot hold.
    const orgContexts = result.current.principals.flatMap((p) =>
      p.contexts.filter((c) => c.accountId === 'org'),
    );
    expect(orgContexts.map((c) => c.contextId)).toEqual(['ctx-nate-org', 'ctx-alice-org']);
    // The rows are grouped under the person who reaches them, which is the only
    // place the actor survives once a row is flattened to a display model.
    expect(
      result.current.principals
        .filter((p) => p.contexts.some((c) => c.accountId === 'org'))
        .map((p) => p.principalId),
    ).toEqual(['p-nate', 'p-alice']);
  });

  it('surfaces the active pair with its actor, not merely its account', () => {
    snapshot = makeSnapshot({ directory: sharedDirectory('ctx-alice-org') });

    const { result } = renderHook(() => useDeviceSwitcher());

    expect(result.current.activeContext?.contextId).toBe('ctx-alice-org');
    expect(result.current.activeContext?.actor.userId).toBe('alice');
    expect(result.current.activeContext?.isDelegated).toBe(true);
  });

  it('surfaces the in-flight flags each operation reports', () => {
    snapshot = makeSnapshot({
      directory: sharedDirectory('ctx-nate'),
      loading: true,
      activatingContextId: 'ctx-nate-org',
      removingContextId: 'ctx-alice-org',
      removingPrincipalId: 'p-alice',
    });

    const { result } = renderHook(() => useDeviceSwitcher());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.activatingContextId).toBe('ctx-nate-org');
    expect(result.current.removingContextId).toBe('ctx-alice-org');
    expect(result.current.removingPrincipalId).toBe('p-alice');
  });

  it('forwards each operation to its OWN controller call', async () => {
    snapshot = makeSnapshot({ directory: sharedDirectory('ctx-nate') });

    const { result } = renderHook(() => useDeviceSwitcher());

    await act(async () => {
      await result.current.activateContext('ctx-alice-org');
      await result.current.signOutContext('ctx-alice-org');
      await result.current.signOutPrincipal('p-alice');
    });

    expect(controller.activateContext).toHaveBeenCalledWith('ctx-alice-org');
    expect(controller.signOutContext).toHaveBeenCalledWith('ctx-alice-org');
    // The one that matters: removing a PERSON must not go through the context
    // endpoint, which would drop one pair and leave them on the device. Every
    // single-principal fixture would pass either way.
    expect(controller.signOutPrincipal).toHaveBeenCalledWith('p-alice');
    expect(controller.signOutContext).toHaveBeenCalledTimes(1);
  });

  it('is inert before the provider mounts, and refuses rather than pretends', async () => {
    mockController = null;

    const { result } = renderHook(() => useDeviceSwitcher());

    expect(result.current.principals).toEqual([]);
    expect(result.current.activeContext).toBeNull();
    expect(result.current.isLoading).toBe(false);
    // `false`, never a silent `true`: with no controller nothing happened, and a
    // caller that believed otherwise would close its dialog on a no-op.
    await expect(result.current.activateContext('ctx-nate')).resolves.toBe(false);
    await expect(result.current.signOutContext('ctx-nate')).resolves.toBe(false);
    await expect(result.current.signOutPrincipal('p-nate')).resolves.toBe(false);
  });
});
