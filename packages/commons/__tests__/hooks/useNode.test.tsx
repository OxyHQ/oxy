import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UserNodeStatus } from '@oxy.so/core';
import { __resetOxyState, __setOxyState } from '@/__mocks__/oxy-services';

const authenticateMock = jest.fn<Promise<{ success: boolean; error?: string }>, [string?]>();
jest.mock('@/lib/biometricAuth', () => ({
  authenticate: (...args: [string?]) => authenticateMock(...args),
}));

// eslint-disable-next-line import/first
import {
  useMyNode,
  useRegisterNode,
  useProvisionVault,
  useRemoveNode,
  useSyncNode,
  nodeErrorCode,
} from '@/hooks/useNode';

const MY_USER_ID = 'me';
const NODE_PUBLIC_KEY = 'a'.repeat(64);

/** A managed, active node status (the `getMyNode` shape). */
function makeNode(overrides: Partial<UserNodeStatus> = {}): UserNodeStatus {
  return {
    endpoint: 'https://node.example.com',
    nodePublicKey: NODE_PUBLIC_KEY,
    mode: 'pull',
    managed: true,
    controller: 'oxy',
    status: 'active',
    lastSeenAt: '2026-06-28T00:00:00.000Z',
    lastSyncedAt: '2026-06-28T00:00:00.000Z',
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
    ...overrides,
  };
}

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/** Install an authenticated session with the given service method overrides. */
function install(overrides: Record<string, jest.Mock> = {}) {
  const services = {
    getMyNode: jest.fn(async () => makeNode()),
    registerNode: jest.fn(async () => makeNode({ managed: false, controller: 'self' })),
    provisionManagedVault: jest.fn(async () => makeNode()),
    removeMyNode: jest.fn(async () => ({ revoked: true })),
    notifyNodeIngest: jest.fn(async () => undefined),
    ...overrides,
  };
  __setOxyState({ isAuthenticated: true, user: { id: MY_USER_ID }, oxyServices: services });
  return services;
}

describe('useMyNode', () => {
  beforeEach(() => {
    __resetOxyState();
    authenticateMock.mockReset();
  });

  it('resolves the current user node status from getMyNode', async () => {
    const services = install();
    const { result } = renderHook(() => useMyNode(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(services.getMyNode).toHaveBeenCalledTimes(1);
    expect(result.current.data?.status).toBe('active');
    expect(result.current.data?.managed).toBe(true);
    expect(result.current.data?.endpoint).toBe('https://node.example.com');
  });

  it('surfaces a null status (no node) without erroring', async () => {
    install({ getMyNode: jest.fn(async () => null) });
    const { result } = renderHook(() => useMyNode(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(result.current.isError).toBe(false);
  });

  it('is disabled until a current user id is known', () => {
    const getMyNode = jest.fn(async () => makeNode());
    const getCurrentUserId = jest.fn(() => null);
    __setOxyState({ user: null, oxyServices: { getMyNode, getCurrentUserId } });

    const { result } = renderHook(() => useMyNode(), { wrapper: makeWrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    expect(getMyNode).not.toHaveBeenCalled();
  });
});

describe('useRegisterNode', () => {
  beforeEach(() => {
    __resetOxyState();
    authenticateMock.mockReset();
  });

  it('signs + registers via registerNode only AFTER the biometric gate passes', async () => {
    const services = install();
    authenticateMock.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useRegisterNode('reason'), { wrapper: makeWrapper() });

    await act(async () => {
      await result.current.register({
        endpoint: 'https://node.example.com',
        nodePublicKey: NODE_PUBLIC_KEY,
        mode: 'pull',
      });
    });

    expect(authenticateMock).toHaveBeenCalledWith('reason');
    expect(services.registerNode).toHaveBeenCalledWith({
      endpoint: 'https://node.example.com',
      nodePublicKey: NODE_PUBLIC_KEY,
      mode: 'pull',
    });
    await waitFor(() => expect(result.current.state).toBe('done'));
    expect(result.current.result?.controller).toBe('self');
  });

  it('does NOT register when the biometric gate fails', async () => {
    const services = install();
    authenticateMock.mockResolvedValue({ success: false, error: 'user_cancel' });
    const { result } = renderHook(() => useRegisterNode('reason'), { wrapper: makeWrapper() });

    await act(async () => {
      await result.current.register({ endpoint: 'https://node.example.com', nodePublicKey: NODE_PUBLIC_KEY });
    });

    expect(services.registerNode).not.toHaveBeenCalled();
    expect(result.current.biometricFailed).toBe(true);
    expect(result.current.state).toBe('idle');
  });

  it('classifies a rejected (unmaterialized) endpoint into invalid_endpoint', async () => {
    install({
      registerNode: jest.fn(async () => {
        throw new Error('Node registration stored but the node could not be materialized.');
      }),
    });
    authenticateMock.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useRegisterNode('reason'), { wrapper: makeWrapper() });

    await act(async () => {
      await result.current.register({ endpoint: 'https://bad', nodePublicKey: NODE_PUBLIC_KEY });
    });

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.errorCode).toBe('invalid_endpoint');
  });
});

describe('useProvisionVault', () => {
  beforeEach(() => {
    __resetOxyState();
    authenticateMock.mockReset();
  });

  it('provisions via provisionManagedVault only AFTER the biometric gate passes', async () => {
    const services = install();
    authenticateMock.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useProvisionVault('reason'), { wrapper: makeWrapper() });

    await act(async () => {
      await result.current.provision();
    });

    expect(authenticateMock).toHaveBeenCalledWith('reason');
    expect(services.provisionManagedVault).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.state).toBe('done'));
    expect(result.current.result?.managed).toBe(true);
  });

  it('does NOT provision when the biometric gate fails', async () => {
    const services = install();
    authenticateMock.mockResolvedValue({ success: false, error: 'user_cancel' });
    const { result } = renderHook(() => useProvisionVault('reason'), { wrapper: makeWrapper() });

    await act(async () => {
      await result.current.provision();
    });

    expect(services.provisionManagedVault).not.toHaveBeenCalled();
    expect(result.current.biometricFailed).toBe(true);
    expect(result.current.state).toBe('idle');
  });

  it('classifies a 503 config-unavailable rejection into managed_unavailable', async () => {
    install({
      provisionManagedVault: jest.fn(async () => {
        const err = new Error('Managed vaults are not available right now') as Error & { status: number };
        err.status = 503;
        throw err;
      }),
    });
    authenticateMock.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useProvisionVault('reason'), { wrapper: makeWrapper() });

    await act(async () => {
      await result.current.provision();
    });

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.errorCode).toBe('managed_unavailable');
  });
});

describe('useRemoveNode', () => {
  beforeEach(() => {
    __resetOxyState();
    authenticateMock.mockReset();
  });

  it('revokes via removeMyNode only AFTER the biometric gate passes', async () => {
    const services = install();
    authenticateMock.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useRemoveNode('reason'), { wrapper: makeWrapper() });

    await act(async () => {
      await result.current.remove();
    });

    expect(authenticateMock).toHaveBeenCalledWith('reason');
    expect(services.removeMyNode).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.state).toBe('done'));
  });

  it('does NOT revoke when the biometric gate fails', async () => {
    const services = install();
    authenticateMock.mockResolvedValue({ success: false, error: 'user_cancel' });
    const { result } = renderHook(() => useRemoveNode('reason'), { wrapper: makeWrapper() });

    await act(async () => {
      await result.current.remove();
    });

    expect(services.removeMyNode).not.toHaveBeenCalled();
    expect(result.current.biometricFailed).toBe(true);
    expect(result.current.state).toBe('idle');
  });
});

describe('useSyncNode', () => {
  beforeEach(() => {
    __resetOxyState();
    authenticateMock.mockReset();
  });

  it('sends the ingest hint WITHOUT a biometric gate', async () => {
    const services = install();
    const { result } = renderHook(() => useSyncNode(), { wrapper: makeWrapper() });

    await act(async () => {
      await result.current.sync();
    });

    expect(authenticateMock).not.toHaveBeenCalled();
    expect(services.notifyNodeIngest).toHaveBeenCalledWith(MY_USER_ID);
    await waitFor(() => expect(result.current.state).toBe('done'));
  });

  it('surfaces a quiet error state when the hint fails', async () => {
    install({
      notifyNodeIngest: jest.fn(async () => {
        throw new Error('network');
      }),
    });
    const { result } = renderHook(() => useSyncNode(), { wrapper: makeWrapper() });

    await act(async () => {
      await result.current.sync();
    });

    await waitFor(() => expect(result.current.state).toBe('error'));
  });
});

describe('nodeErrorCode', () => {
  it('maps the SDK 503 + message to managed_unavailable', () => {
    const err = new Error('Managed vaults are not available right now') as Error & { status: number };
    err.status = 503;
    expect(nodeErrorCode(err)).toBe('managed_unavailable');
  });

  it('maps the unmaterialized-registration message to invalid_endpoint', () => {
    expect(nodeErrorCode(new Error('Node registration stored but the node could not be materialized.'))).toBe(
      'invalid_endpoint',
    );
  });

  it('maps the no-user guard to not_authenticated', () => {
    expect(nodeErrorCode(new Error('No authenticated user — sign in before registering a node.'))).toBe(
      'not_authenticated',
    );
  });

  it('falls back to generic for an unmodelled error', () => {
    expect(nodeErrorCode(new Error('boom'))).toBe('generic');
  });
});
