import { useEffect, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Platform } from 'react-native';
import type { IdentityStatus } from '@oxy.so/core';
import { KeyManager } from '@oxy.so/core';
import { __resetOxyState, __setOxyState } from '@/__mocks__/oxy-services';

const getIdentityStatusMock = jest.fn<Promise<IdentityStatus>, [unknown?]>();

// The listener registered via subscribeIdentityChanged — captured so tests can
// fire an identity-change event (the seam the root layout uses).
let identityChangeListener: (() => void) | null = null;
const subscribeIdentityChangedMock = jest.fn((listener: () => void) => {
  identityChangeListener = listener;
  return () => {
    if (identityChangeListener === listener) identityChangeListener = null;
  };
});

// Mock KeyManager.getIdentityStatus (the sole identity probe the hook now uses)
// and subscribeIdentityChanged surgically. Everything else passes through to the
// real built module so types + error classes remain consistent.
jest.mock('@oxy.so/core', () => {
  const actual = jest.requireActual('@oxy.so/core');
  return {
    ...actual,
    KeyManager: {
      ...actual.KeyManager,
      getIdentityStatus: (opts?: unknown) => getIdentityStatusMock(opts),
      subscribeIdentityChanged: (listener: () => void) => subscribeIdentityChangedMock(listener),
    },
  };
});

// Deterministic control over the LOCAL "onboarding complete" milestone. The hook
// reads it via `getOnboardingCompleteFromStorage` and writes via
// `persistOnboardingComplete`; both are mocked over a plain in-memory flag so we
// can simulate a RETURNING user (`= true`) vs first-time onboarding (`= false`).
let mockOnboardingCompleteFlag = false;
let mockOnboardingFlow: 'create' | 'import' | null = null;
jest.mock('@/hooks/identity/identityStore', () => {
  const actual = jest.requireActual('@/hooks/identity/identityStore');
  return {
    ...actual,
    getOnboardingCompleteFromStorage: jest.fn(async () => mockOnboardingCompleteFlag),
    getOnboardingFlowFromStorage: jest.fn(async () => mockOnboardingFlow),
    persistOnboardingComplete: jest.fn(async (complete: boolean) => {
      mockOnboardingCompleteFlag = complete;
    }),
  };
});

// Imported AFTER jest.mock so the hook sees the patched modules.
// eslint-disable-next-line import/first
import {
  useOnboardingStatus,
  ONBOARDING_IDENTITY_QUERY_KEY,
  ONBOARDING_COMPLETE_QUERY_KEY,
  getOnboardingResumeHref,
} from '@/hooks/useOnboardingStatus';
// eslint-disable-next-line import/first
import { persistOnboardingComplete } from '@/hooks/identity/identityStore';

const PRESENT: IdentityStatus = { state: 'present', publicKey: 'pub-abc' };
const ABSENT: IdentityStatus = { state: 'absent' };
const LOST: IdentityStatus = {
  state: 'lost',
  marker: { v: 1, publicKey: 'pub-lost', createdAt: 1, origin: 'create' },
};
const unavailable = (): IdentityStatus => ({ state: 'unavailable', cause: new Error('locked') });

// Each render needs its own QueryClient so the `staleTime: Infinity` cache never
// leaks across cases. A helper that also exposes the client for the tests that
// drive invalidation/refetch directly.
function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
}
function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}
function createWrapper() {
  return wrapperFor(makeClient());
}

describe('useOnboardingStatus', () => {
  beforeEach(() => {
    __resetOxyState();
    getIdentityStatusMock.mockReset();
    subscribeIdentityChangedMock.mockClear();
    identityChangeListener = null;
    mockOnboardingCompleteFlag = false;
    mockOnboardingFlow = null;
    Platform.OS = 'ios';
  });

  // Safety net: guarantee real timers are restored between cases even if a
  // fake-timer test throws/times out before its own cleanup runs, so leftover
  // fake timers can never corrupt a later test's async flush.
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports status "none" when the verdict is absent (fresh device)', async () => {
    getIdentityStatusMock.mockResolvedValue(ABSENT);
    const { result } = renderHook(() => useOnboardingStatus(), { wrapper: createWrapper() });
    await waitFor(() => {
      expect(result.current.status).toBe('none');
    });
    expect(result.current.hasIdentity).toBe(false);
    expect(result.current.identityPresent).toBe(false);
    expect(result.current.hasUsername).toBe(false);
  });

  it('reports "in_progress" when identity is present but the user is not authenticated', async () => {
    getIdentityStatusMock.mockResolvedValue(PRESENT);
    __setOxyState({ isAuthenticated: false, user: null });
    const { result } = renderHook(() => useOnboardingStatus(), { wrapper: createWrapper() });
    await waitFor(() => {
      expect(result.current.status).toBe('in_progress');
    });
    expect(result.current.hasIdentity).toBe(true);
    expect(result.current.identityPresent).toBe(true);
  });

  it('reports "complete" when present, authenticated, and has username', async () => {
    getIdentityStatusMock.mockResolvedValue(PRESENT);
    __setOxyState({ isAuthenticated: true, user: { username: 'alice' } });
    const { result } = renderHook(() => useOnboardingStatus(), { wrapper: createWrapper() });
    await waitFor(() => {
      expect(result.current.status).toBe('complete');
    });
    expect(result.current.hasUsername).toBe(true);
  });

  it('reports "in_progress" when authenticated but username is missing', async () => {
    getIdentityStatusMock.mockResolvedValue(PRESENT);
    __setOxyState({ isAuthenticated: true, user: {} });
    const { result } = renderHook(() => useOnboardingStatus(), { wrapper: createWrapper() });
    await waitFor(() => {
      expect(result.current.status).toBe('in_progress');
    });
    expect(result.current.hasUsername).toBe(false);
  });

  it('needsAuth is true when status is "none"', async () => {
    getIdentityStatusMock.mockResolvedValue(ABSENT);
    const { result } = renderHook(() => useOnboardingStatus(), { wrapper: createWrapper() });
    await waitFor(() => {
      expect(result.current.status).toBe('none');
    });
    expect(result.current.needsAuth).toBe(true);
  });

  it('needsAuth is true when status is "in_progress"', async () => {
    getIdentityStatusMock.mockResolvedValue(PRESENT);
    const { result } = renderHook(() => useOnboardingStatus(), { wrapper: createWrapper() });
    await waitFor(() => {
      expect(result.current.status).toBe('in_progress');
    });
    expect(result.current.needsAuth).toBe(true);
  });

  it('needsAuth is false only when status is "complete"', async () => {
    getIdentityStatusMock.mockResolvedValue(PRESENT);
    __setOxyState({ isAuthenticated: true, user: { username: 'alice' } });
    const { result } = renderHook(() => useOnboardingStatus(), { wrapper: createWrapper() });
    await waitFor(() => {
      expect(result.current.status).toBe('complete');
    });
    expect(result.current.needsAuth).toBe(false);
  });

  it('web follows the same status-driven gate (absent → none → needsAuth)', async () => {
    Platform.OS = 'web';
    getIdentityStatusMock.mockResolvedValue(ABSENT);
    const { result } = renderHook(() => useOnboardingStatus(), { wrapper: createWrapper() });
    await waitFor(() => {
      expect(result.current.status).toBe('none');
    });
    expect(result.current.needsAuth).toBe(true);
  });

  it('starts "checking" until the identity probe resolves', async () => {
    let releaseProbe: (value: IdentityStatus) => void = () => undefined;
    getIdentityStatusMock.mockImplementation(
      () => new Promise<IdentityStatus>((resolve) => {
        releaseProbe = resolve;
      }),
    );
    const { result } = renderHook(() => useOnboardingStatus(), { wrapper: createWrapper() });
    expect(result.current.status).toBe('checking');
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      releaseProbe(ABSENT);
    });
    await waitFor(() => {
      expect(result.current.status).toBe('none');
    });
    expect(result.current.isLoading).toBe(false);
  });

  // ── The KEY regression: routing must NOT wait on the session ────────────────
  it('reports "complete" from local reads WHILE isAuthResolved is false (present + milestone)', async () => {
    // A returning user opens the app: the identity is present locally and the
    // onboarding milestone is set, but the device-first cold boot has NOT
    // concluded (`isAuthResolved: false`) and there is no session yet. Routing is
    // decided from the LOCAL reads only, so this must resolve to `complete` and
    // NEVER stall on the unresolved session.
    getIdentityStatusMock.mockResolvedValue(PRESENT);
    mockOnboardingCompleteFlag = true;
    __setOxyState({ isAuthResolved: false, isAuthenticated: false, user: null });

    const { result } = renderHook(() => useOnboardingStatus(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.status).toBe('complete');
    });
    expect(result.current.needsAuth).toBe(false);
    expect(result.current.hasIdentity).toBe(true);
    // The session is still resolving in the background — exposed but not gating.
    expect(result.current.isSessionResolving).toBe(true);
  });

  // Every terminal verdict must be reachable while the SDK cold boot is STILL
  // unresolved. `sessionMode="identity"` moved session restore entirely into the
  // SDK (`identity-key-signin`), so nothing in this app connects a session any
  // more — which makes it doubly important that routing never waits on one.
  describe('local-first: no terminal verdict waits on the cold boot', () => {
    it('routes a marker-backed lost identity to recovery while isAuthResolved is false', async () => {
      getIdentityStatusMock.mockResolvedValue(LOST);
      __setOxyState({ isAuthResolved: false, isAuthenticated: false, user: null });
      const { result } = renderHook(() => useOnboardingStatus(), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.status).toBe('recovery');
      });
      expect(result.current.unavailableReason).toBe('lost');
      expect(result.current.isSessionResolving).toBe(true);
    });

    it('routes a genuinely fresh device to "none" while isAuthResolved is false', async () => {
      getIdentityStatusMock.mockResolvedValue(ABSENT);
      __setOxyState({ isAuthResolved: false, isAuthenticated: false, user: null });
      const { result } = renderHook(() => useOnboardingStatus(), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.status).toBe('none');
      });
      expect(result.current.isSessionResolving).toBe(true);
    });

    it('routes an unreadable keystore to "unavailable" while isAuthResolved is false', async () => {
      jest.useFakeTimers();
      try {
        getIdentityStatusMock.mockResolvedValue(unavailable());
        __setOxyState({ isAuthResolved: false, isAuthenticated: false, user: null });
        const { result } = renderHook(() => useOnboardingStatus(), { wrapper: createWrapper() });

        await act(async () => {
          await jest.advanceTimersByTimeAsync(1500);
        });

        expect(result.current.status).toBe('unavailable');
        expect(result.current.unavailableReason).toBe('locked');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it('exposes isSessionResolving=false once the cold boot resolves', async () => {
    getIdentityStatusMock.mockResolvedValue(PRESENT);
    mockOnboardingCompleteFlag = true;
    __setOxyState({ isAuthResolved: true, isAuthenticated: false, user: null });
    const { result } = renderHook(() => useOnboardingStatus(), { wrapper: createWrapper() });
    await waitFor(() => {
      expect(result.current.status).toBe('complete');
    });
    expect(result.current.isSessionResolving).toBe(false);
  });

  // ── Offline / device-first identity-loss guard ──────────────────────────────
  describe('offline returning user (no session)', () => {
    it('routes a previously-onboarded identity to the vault OFFLINE ("complete", needsAuth false)', async () => {
      getIdentityStatusMock.mockResolvedValue(PRESENT);
      mockOnboardingCompleteFlag = true;
      __setOxyState({ isAuthResolved: true, isAuthenticated: false, user: null });
      const { result } = renderHook(() => useOnboardingStatus(), { wrapper: createWrapper() });
      await waitFor(() => {
        expect(result.current.status).toBe('complete');
      });
      expect(result.current.needsAuth).toBe(false);
    });

    it('NEVER downgrades an existing offline identity into the create flow ("none")', async () => {
      getIdentityStatusMock.mockResolvedValue(PRESENT);
      mockOnboardingCompleteFlag = true;
      __setOxyState({ isAuthResolved: true, isAuthenticated: false, user: null });
      const { result } = renderHook(() => useOnboardingStatus(), { wrapper: createWrapper() });
      await waitFor(() => {
        expect(result.current.status).not.toBe('checking');
      });
      expect(result.current.status).not.toBe('none');
      expect(result.current.status).toBe('complete');
    });

    it('keeps a never-completed identity in the wizard OFFLINE ("in_progress")', async () => {
      getIdentityStatusMock.mockResolvedValue(PRESENT);
      mockOnboardingCompleteFlag = false;
      __setOxyState({ isAuthResolved: true, isAuthenticated: false, user: null });
      const { result } = renderHook(() => useOnboardingStatus(), { wrapper: createWrapper() });
      await waitFor(() => {
        expect(result.current.status).toBe('in_progress');
      });
      expect(result.current.needsAuth).toBe(true);
    });
  });

  // ── Loss detection: lost / unavailable never fall through to "none" ─────────
  it('reports "recovery" when the verdict is lost, never "none"', async () => {
    getIdentityStatusMock.mockResolvedValue(LOST);
    __setOxyState({ isAuthResolved: true, isAuthenticated: false, user: null });
    const statuses: string[] = [];
    const { result } = renderHook(() => useOnboardingStatus(), { wrapper: createWrapper() });
    statuses.push(result.current.status);
    await waitFor(() => {
      expect(result.current.status).toBe('recovery');
    });
    statuses.push(result.current.status);
    expect(statuses).not.toContain('none');
    expect(result.current.needsAuth).toBe(true);
    expect(result.current.unavailableReason).toBe('lost');
  });

  it('reports "unavailable" when the probe persistently throws, never "none"', async () => {
    jest.useFakeTimers();
    try {
      getIdentityStatusMock.mockResolvedValue(unavailable());
      __setOxyState({ isAuthResolved: true, isAuthenticated: false, user: null });
      const { result } = renderHook(() => useOnboardingStatus(), { wrapper: createWrapper() });
      expect(result.current.status).toBe('checking');

      // Advance through both retry delays (250ms + 1000ms) to exhaust retries.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1500);
      });

      expect(result.current.status).toBe('unavailable');
      expect(result.current.needsAuth).toBe(true);
      expect(result.current.unavailableReason).toBe('locked');
    } finally {
      jest.useRealTimers();
    }
  });

  it('never reports "none" while the probe throws twice then resolves present', async () => {
    jest.useFakeTimers();
    try {
      getIdentityStatusMock
        .mockResolvedValueOnce(unavailable())
        .mockResolvedValueOnce(unavailable())
        .mockResolvedValue(PRESENT);
      mockOnboardingCompleteFlag = true;
      __setOxyState({ isAuthResolved: false, isAuthenticated: false, user: null });

      const statuses: string[] = [];
      const { result } = renderHook(() => useOnboardingStatus(), { wrapper: createWrapper() });
      statuses.push(result.current.status);

      await act(async () => {
        await jest.advanceTimersByTimeAsync(300);
      });
      statuses.push(result.current.status);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1200);
      });
      statuses.push(result.current.status);

      expect(statuses).not.toContain('none');
      expect(result.current.status).toBe('complete');
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a cached "present" verdict sticky across a later failing refetch', async () => {
    jest.useFakeTimers();
    try {
      getIdentityStatusMock.mockResolvedValue(PRESENT);
      __setOxyState({ isAuthResolved: true, isAuthenticated: false, user: null });
      const client = makeClient();
      const { result } = renderHook(() => useOnboardingStatus(), {
        wrapper: wrapperFor(client),
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(10);
      });
      expect(result.current.status).toBe('in_progress'); // present + no milestone

      // A later refetch throws persistently — the cached present must stick, so
      // the status can never regress to `unavailable`. Do NOT await
      // `invalidateQueries` (its refetch resolves only once the fake-timer retry
      // delays are advanced below — awaiting it first would deadlock).
      getIdentityStatusMock.mockResolvedValue(unavailable());
      await act(async () => {
        void client.invalidateQueries({ queryKey: ONBOARDING_IDENTITY_QUERY_KEY });
        await jest.advanceTimersByTimeAsync(2000);
      });

      expect(result.current.status).toBe('in_progress');
      expect(result.current.identityPresent).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  // ── Late session upgrade ────────────────────────────────────────────────────
  it('upgrades in_progress → complete when the session lands late, persisting the milestone', async () => {
    (persistOnboardingComplete as jest.Mock).mockClear();
    getIdentityStatusMock.mockResolvedValue(PRESENT);
    mockOnboardingCompleteFlag = false;
    __setOxyState({ isAuthResolved: true, isAuthenticated: false, user: null });
    const { result } = renderHook(() => useOnboardingStatus(), { wrapper: createWrapper() });
    await waitFor(() => {
      expect(result.current.status).toBe('in_progress');
    });

    await act(async () => {
      __setOxyState({ isAuthenticated: true, user: { username: 'alice' } });
    });

    await waitFor(() => {
      expect(result.current.status).toBe('complete');
    });
    await waitFor(() => {
      expect(persistOnboardingComplete).toHaveBeenCalledWith(true);
    });
  });

  // ── Event-driven refresh (the root layout's subscribeIdentityChanged wiring) ─
  it('re-reads the verdict when an identity-change event fires (routing refresh)', async () => {
    getIdentityStatusMock.mockResolvedValue(ABSENT);
    const client = makeClient();
    // Mirror the root layout's subscription so firing the captured listener
    // invalidates the shared probes exactly as AppStackContent does.
    function SubscriberHarness() {
      const qc = useQueryClient();
      useEffect(
        () =>
          KeyManager.subscribeIdentityChanged(() => {
            qc.invalidateQueries({ queryKey: ONBOARDING_IDENTITY_QUERY_KEY });
            qc.invalidateQueries({ queryKey: ONBOARDING_COMPLETE_QUERY_KEY });
          }),
        [qc],
      );
      return null;
    }
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <SubscriberHarness />
        {children}
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useOnboardingStatus(), { wrapper });
    await waitFor(() => {
      expect(result.current.status).toBe('none');
    });
    expect(subscribeIdentityChangedMock).toHaveBeenCalled();

    // An identity is created elsewhere → the verdict flips + milestone set.
    mockOnboardingCompleteFlag = true;
    getIdentityStatusMock.mockResolvedValue(PRESENT);
    act(() => {
      identityChangeListener?.();
    });

    await waitFor(() => {
      expect(result.current.status).toBe('complete');
    });
  });

  describe('onboarding-complete milestone persistence', () => {
    it('persists the milestone when onboarding genuinely completes online', async () => {
      (persistOnboardingComplete as jest.Mock).mockClear();
      getIdentityStatusMock.mockResolvedValue(PRESENT);
      __setOxyState({ isAuthResolved: true, isAuthenticated: true, user: { username: 'alice' } });
      const { result } = renderHook(() => useOnboardingStatus(), { wrapper: createWrapper() });
      await waitFor(() => {
        expect(result.current.status).toBe('complete');
      });
      await waitFor(() => {
        expect(persistOnboardingComplete).toHaveBeenCalledWith(true);
      });
    });

    it('does NOT persist while onboarding is still incomplete (no username)', async () => {
      (persistOnboardingComplete as jest.Mock).mockClear();
      getIdentityStatusMock.mockResolvedValue(PRESENT);
      __setOxyState({ isAuthResolved: true, isAuthenticated: true, user: {} });
      const { result } = renderHook(() => useOnboardingStatus(), { wrapper: createWrapper() });
      await waitFor(() => {
        expect(result.current.status).toBe('in_progress');
      });
      expect(persistOnboardingComplete).not.toHaveBeenCalled();
    });
  });

  it('exposes the persisted onboarding flow', async () => {
    mockOnboardingFlow = 'import';
    getIdentityStatusMock.mockResolvedValue(PRESENT);
    const { result } = renderHook(() => useOnboardingStatus(), { wrapper: createWrapper() });
    await waitFor(() => {
      expect(result.current.onboardingFlow).toBe('import');
    });
  });
});

describe('getOnboardingResumeHref', () => {
  it('routes import resumes to the import username step', () => {
    expect(getOnboardingResumeHref('import')).toBe('/(auth)/import-identity/username');
  });

  it('defaults create resumes to the create wizard entry', () => {
    expect(getOnboardingResumeHref(null)).toBe('/(auth)/create-identity');
    expect(getOnboardingResumeHref('create')).toBe('/(auth)/create-identity');
  });
});
