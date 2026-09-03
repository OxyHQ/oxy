// @vitest-environment jsdom

import type { PropsWithChildren } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const makeRequest = vi.fn()

vi.mock('@oxyhq/services', () => ({
  useAuth: () => ({
    oxyServices: { makeRequest },
    isAuthenticated: true,
    isReady: true,
  }),
}))

import {
  useAccountProviderConnections,
  useCreateApplicationProviderConnection,
  useProviderConnectionAudit,
  useProviderValidationDeployments,
  useReconcileProviderConnection,
  useRotateProviderConnection,
  useStartProviderCredentialValidation,
} from '../use-provider-connections'

function harness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { queryClient, wrapper }
}

function connection() {
  return {
    schemaVersion: 2,
    connectionId: 'conn_1',
    provider: 'openai',
    ownerAccountId: 'account_1',
    scope: {
      kind: 'application',
      accountId: 'account_1',
      applicationId: 'app_1',
    },
    environment: 'production',
    status: 'active',
    custodyState: 'ready',
    credentialHandle: `kcred_${'a'.repeat(26)}`,
    credentialRevision: 7,
    keyPrefix: 'sk-partial12',
    fingerprint: 'b'.repeat(64),
    validation: { state: 'valid' },
    upstreamBillsCustomerDirectly: true,
    createdAt: '2026-09-02T00:00:00.000Z',
  }
}

beforeEach(() => {
  makeRequest.mockReset()
})

describe('provider credential cache boundaries', () => {
  it('projects connection and audit responses before QueryCache stores them', async () => {
    makeRequest.mockImplementation((_method: string, url: string) => {
      if (url.endsWith('/audit')) {
        return Promise.resolve([
          {
            eventType: 'created',
            actorKind: 'user',
            actorUserId: 'user_1',
            environment: 'production',
            createdAt: '2026-09-02T00:00:00.000Z',
            metadata: { secretLikeOpenShape: 'must-not-be-cached' },
          },
        ])
      }
      return Promise.resolve([connection()])
    })
    const { queryClient, wrapper } = harness()

    const connections = renderHook(
      () => useAccountProviderConnections('account_1'),
      { wrapper },
    )
    const audit = renderHook(() => useProviderConnectionAudit('conn_1'), {
      wrapper,
    })
    await waitFor(() => expect(connections.result.current.isSuccess).toBe(true))
    await waitFor(() => expect(audit.result.current.isSuccess).toBe(true))

    const cachedConnections = queryClient.getQueryData([
      'provider-connections',
      'account_1',
    ])
    expect(JSON.stringify(cachedConnections)).not.toContain('kcred_')
    expect(JSON.stringify(cachedConnections)).not.toContain('fingerprint')
    expect(JSON.stringify(cachedConnections)).not.toContain('keyPrefix')
    expect(JSON.stringify(cachedConnections)).not.toContain(
      'credentialRevision',
    )

    const cachedAudit = queryClient.getQueryData([
      'provider-connection-audit',
      'conn_1',
    ])
    expect(JSON.stringify(cachedAudit)).not.toContain('metadata')
    expect(JSON.stringify(cachedAudit)).not.toContain('must-not-be-cached')
  })

  it.each(['create', 'rotate'] as const)(
    'keeps a %s secret out of MutationCache and HttpService dedupe keys',
    async (operation) => {
      makeRequest.mockResolvedValue(connection())
      const { queryClient, wrapper } = harness()
      const secret = `secret-${operation}-value`

      if (operation === 'create') {
        const hook = renderHook(
          () => useCreateApplicationProviderConnection(),
          { wrapper },
        )
        await act(async () => {
          await hook.result.current.mutateAsync({
            applicationId: 'app_1',
            ownerAccountId: 'account_1',
            provider: 'openai',
            environment: 'production',
            secret,
            acknowledgeProviderTerms: false,
          })
        })
      } else {
        const hook = renderHook(() => useRotateProviderConnection(), {
          wrapper,
        })
        await act(async () => {
          await hook.result.current.mutateAsync({
            connectionId: 'conn_1',
            ownerAccountId: 'account_1',
            secret,
          })
        })
      }

      expect(queryClient.getMutationCache().getAll()).toEqual([])
      expect(makeRequest).toHaveBeenCalledWith(
        'POST',
        expect.any(String),
        expect.objectContaining({ secret }),
        { retry: false, deduplicate: false },
      )
    },
  )

  it('does not retain a rejected secret in MutationCache', async () => {
    makeRequest.mockRejectedValue(new Error('refused'))
    const { queryClient, wrapper } = harness()
    queryClient.setQueryData(
      ['provider-connections', 'account_1'],
      [connection()],
    )
    const hook = renderHook(() => useCreateApplicationProviderConnection(), {
      wrapper,
    })

    await expect(
      act(() =>
        hook.result.current.mutateAsync({
          applicationId: 'app_1',
          ownerAccountId: 'account_1',
          provider: 'openai',
          environment: 'production',
          secret: 'one-byte-would-still-not-be-cached',
          acknowledgeProviderTerms: false,
        }),
      ),
    ).rejects.toThrow('refused')
    expect(queryClient.getMutationCache().getAll()).toEqual([])
    expect(
      queryClient.getQueryState(['provider-connections', 'account_1'])
        ?.isInvalidated,
    ).toBe(true)
  })

  it('keeps a recovery credential out of caches and invalidates both views on failure', async () => {
    makeRequest.mockRejectedValue(new Error('outcome still unavailable'))
    const { queryClient, wrapper } = harness()
    queryClient.setQueryData(
      ['provider-connections', 'account_1'],
      [connection()],
    )
    queryClient.setQueryData(['provider-connection-audit', 'conn_1'], [])
    const hook = renderHook(() => useReconcileProviderConnection(), { wrapper })
    const secret = 'original-provider-credential'

    await expect(
      act(() =>
        hook.result.current.mutateAsync({
          connectionId: 'conn_1',
          ownerAccountId: 'account_1',
          secret,
        }),
      ),
    ).rejects.toThrow('outcome still unavailable')

    expect(queryClient.getMutationCache().getAll()).toEqual([])
    expect(makeRequest).toHaveBeenCalledWith(
      'POST',
      '/inference/provider-connections/conn_1/reconcile',
      { secret },
      { retry: false, deduplicate: false },
    )
    expect(
      queryClient.getQueryState(['provider-connections', 'account_1'])
        ?.isInvalidated,
    ).toBe(true)
    expect(
      queryClient.getQueryState(['provider-connection-audit', 'conn_1'])
        ?.isInvalidated,
    ).toBe(true)
    expect(JSON.stringify(queryClient.getQueryCache().getAll())).not.toContain(
      secret,
    )
  })

  it('checks a durable recovery outcome without sending a credential', async () => {
    makeRequest.mockResolvedValue(connection())
    const { queryClient, wrapper } = harness()
    const hook = renderHook(() => useReconcileProviderConnection(), { wrapper })

    await act(async () => {
      await hook.result.current.mutateAsync({
        connectionId: 'conn_1',
        ownerAccountId: 'account_1',
      })
    })

    expect(queryClient.getMutationCache().getAll()).toEqual([])
    expect(makeRequest).toHaveBeenCalledWith(
      'POST',
      '/inference/provider-connections/conn_1/reconcile',
      {},
      { retry: false, deduplicate: false },
    )
  })

  it('lists exact deployment IDs and starts only the ID explicitly selected', async () => {
    makeRequest.mockImplementation((method: string, url: string) => {
      if (method === 'GET' && url.endsWith('/validation-deployments')) {
        return Promise.resolve([
          { deploymentId: 'deployment_exact_a' },
          { deploymentId: 'deployment_exact_b' },
        ])
      }
      return Promise.resolve({
        schemaVersion: 1,
        operationId: 'operation_exact',
        connectionId: 'conn_1',
        applicationId: 'app_1',
        deploymentId: 'deployment_exact_b',
        state: 'pending',
        createdAt: '2026-09-03T00:00:00.000Z',
      })
    })
    const { wrapper } = harness()
    const deployments = renderHook(
      () => useProviderValidationDeployments('conn_1', 'app_1'),
      { wrapper },
    )
    await waitFor(() => expect(deployments.result.current.isSuccess).toBe(true))
    expect(deployments.result.current.data).toEqual([
      { deploymentId: 'deployment_exact_a' },
      { deploymentId: 'deployment_exact_b' },
    ])

    const start = renderHook(() => useStartProviderCredentialValidation(), {
      wrapper,
    })
    await act(async () => {
      await start.result.current.mutateAsync({
        connectionId: 'conn_1',
        ownerAccountId: 'account_1',
        applicationId: 'app_1',
        deploymentId: 'deployment_exact_b',
      })
    })
    expect(makeRequest).toHaveBeenLastCalledWith(
      'POST',
      '/inference/provider-connections/conn_1/validation-bootstrap',
      { applicationId: 'app_1', deploymentId: 'deployment_exact_b' },
      { retry: false, deduplicate: false },
    )
  })
})
