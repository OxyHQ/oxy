import { useCallback, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@oxyhq/services'
import type {
  InferenceEnvironment,
  ProviderConnection,
  ProviderCredentialValidationDeployment,
  ProviderCredentialValidationOperation,
} from '@oxyhq/contracts'
import type { ProviderConnectionView } from '@/lib/provider-connection'
import { toProviderConnectionView } from '@/lib/provider-connection'

// ===========================================================================
// BYOK provider connections (`/inference/provider-connections`, issue #972
// workstream 10).
//
// A customer registers their own upstream provider credential; Oxy keeps a
// opaque Kaana handle plus metadata. Nothing in this file returns a
// credential, and every read projects inside `queryFn` BEFORE React Query can
// cache it, dropping the internal handle/revision and open audit metadata.
//
// The customer's credential travels in exactly one direction, through create,
// rotate, or an exact recovery replay that Kaana has proved necessary. Those
// paths use imperative hooks which do NOT use
// MutationCache. `retry:false` prevents network retries and `deduplicate:false`
// prevents HttpService from embedding the request body in an in-flight dedupe
// key. The secret exists only in component state and the active request closure.
// ===========================================================================

/**
 * What kind of principal caused an audit event, as the server records it.
 *
 * Three kinds, and TWO of them carry a null `actorUserId` — which is why the
 * kind has to travel to the client rather than be inferred from the id. See
 * {@link providerConnectionAuditAttribution}.
 */
export type ProviderConnectionActorKind = 'user' | 'service' | 'platform'

/** One entry of a connection's append-only trail. */
export interface ProviderConnectionAuditEvent {
  readonly eventType:
    | 'created'
    | 'validated'
    | 'rotated'
    | 'used'
    | 'disabled'
    | 'enabled'
    | 'revoked'
  /**
   * Who or what caused it. `null` on rows written before the column existed
   * (`0049`), never on a new one — the server's CHECK pairs each kind with the
   * presence or absence of `actorUserId`.
   */
  readonly actorKind: ProviderConnectionActorKind | null
  /** Set only when `actorKind` is `user`; null for `service` and `platform` alike. */
  readonly actorUserId: string | null
  readonly environment: string
  readonly createdAt: string
}

const queryKeys = {
  accountConnections: (accountId: string) =>
    ['provider-connections', accountId] as const,
  audit: (connectionId: string) =>
    ['provider-connection-audit', connectionId] as const,
  validationDeployments: (connectionId: string, applicationId: string) =>
    ['provider-connection-validation-deployments', connectionId, applicationId] as const,
  validation: (connectionId: string, applicationId: string) =>
    ['provider-connection-validation', connectionId, applicationId] as const,
}

/** Exact customer-selectable catalogue rows. No default is selected. */
export function useProviderValidationDeployments(
  connectionId: string | undefined,
  applicationId: string,
  enabled: boolean = true,
) {
  const { oxyServices, isAuthenticated, isReady } = useAuth()
  return useQuery({
    queryKey: queryKeys.validationDeployments(connectionId ?? '', applicationId),
    queryFn: () =>
      oxyServices.makeRequest<Array<ProviderCredentialValidationDeployment>>(
        'GET',
        `/inference/provider-connections/${connectionId ?? ''}/validation-deployments`,
        { applicationId },
        { cache: false },
      ),
    enabled: isReady && isAuthenticated && !!connectionId && enabled,
    staleTime: 30_000,
    retry: 1,
  })
}

/** Latest durable bootstrap outcome for the exact connection/application. */
export function useProviderCredentialValidation(
  connectionId: string | undefined,
  applicationId: string,
  enabled: boolean = true,
) {
  const { oxyServices, isAuthenticated, isReady } = useAuth()
  return useQuery({
    queryKey: queryKeys.validation(connectionId ?? '', applicationId),
    queryFn: () =>
      oxyServices.makeRequest<ProviderCredentialValidationOperation | null>(
        'GET',
        `/inference/provider-connections/${connectionId ?? ''}/validation-bootstrap`,
        { applicationId },
        { cache: false },
      ),
    enabled: isReady && isAuthenticated && !!connectionId && enabled,
    staleTime: 5_000,
    retry: 1,
  })
}

/** Create/retry explicitly with the exact selected catalogue deployment id. */
export function useStartProviderCredentialValidation() {
  const { oxyServices } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      connectionId,
      applicationId,
      deploymentId,
    }: {
      connectionId: string
      ownerAccountId: string
      applicationId: string
      deploymentId: string
    }) =>
      oxyServices.makeRequest<ProviderCredentialValidationOperation>(
        'POST',
        `/inference/provider-connections/${connectionId}/validation-bootstrap`,
        { applicationId, deploymentId },
        { retry: false, deduplicate: false },
      ),
    onSuccess: (_operation, { connectionId, ownerAccountId, applicationId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.accountConnections(ownerAccountId),
      })
      queryClient.invalidateQueries({ queryKey: queryKeys.audit(connectionId) })
      queryClient.invalidateQueries({
        queryKey: queryKeys.validation(connectionId, applicationId),
      })
    },
  })
}

/**
 * Every connection an account owns — its own, its projects', and its
 * applications'.
 *
 * Requires the narrow `inference:providers:read` permission on that account.
 * The component resolves it from the server-supplied membership, never a role
 * name or the broader `account:read` grant.
 */
export function useAccountProviderConnections(
  accountId: string | undefined,
  enabled: boolean = true,
) {
  const { oxyServices, isAuthenticated, isReady } = useAuth()

  return useQuery({
    queryKey: queryKeys.accountConnections(accountId ?? ''),
    queryFn: async (): Promise<Array<ProviderConnectionView>> =>
      (
        await oxyServices.makeRequest<Array<ProviderConnection>>(
          'GET',
          `/inference/provider-connections/accounts/${accountId ?? ''}`,
          undefined,
          { cache: false },
        )
      ).map(toProviderConnectionView),
    enabled: isReady && isAuthenticated && !!accountId && enabled,
    staleTime: 1000 * 30,
    retry: 1,
  })
}

/**
 * A connection's trail: created, validated, rotated, used, disabled, enabled, revoked.
 *
 * The API also returns a `metadata` blob per event. It is projected away here
 * rather than merely left unrendered: it is an open shape several code paths
 * write, and a cache that holds it is one component away from printing it.
 */
export function useProviderConnectionAudit(
  connectionId: string | undefined,
  limit: number = 50,
  enabled: boolean = true,
) {
  const { oxyServices, isAuthenticated, isReady } = useAuth()

  return useQuery({
    queryKey: queryKeys.audit(connectionId ?? ''),
    queryFn: async (): Promise<Array<ProviderConnectionAuditEvent>> =>
      (
        await oxyServices.makeRequest<
          Array<ProviderConnectionAuditEvent & { metadata?: unknown }>
        >(
          'GET',
          `/inference/provider-connections/${connectionId ?? ''}/audit`,
          { limit },
          { cache: false },
        )
      ).map((event) => ({
        eventType: event.eventType,
        // `actorKind` is projected THROUGH, not dropped. It was omitted here
        // until #1057, and the screen re-derived attribution from
        // `actorUserId === null` — which reads every `platform` event, and so
        // every `used` event, as a service credential.
        actorKind: event.actorKind,
        actorUserId: event.actorUserId,
        environment: event.environment,
        createdAt: event.createdAt,
      })),
    enabled: isReady && isAuthenticated && !!connectionId && enabled,
    staleTime: 1000 * 30,
    retry: 1,
  })
}

/** What the create form collects. `secret` is the customer's own upstream credential. */
export interface CreateProviderConnectionInput {
  applicationId: string
  ownerAccountId: string
  provider: string
  environment: InferenceEnvironment
  secret: string
  acknowledgeProviderTerms: boolean
}

/**
 * Register a credential scoped to one application.
 *
 * The owning account is resolved SERVER-side from the application; the
 * `ownerAccountId` carried on the input is only the cache key to invalidate.
 */
export function useCreateApplicationProviderConnection() {
  const { oxyServices } = useAuth()
  const queryClient = useQueryClient()
  const [isPending, setIsPending] = useState(false)

  const mutateAsync = useCallback(
    async ({
      applicationId,
      ownerAccountId,
      provider,
      environment,
      secret,
      acknowledgeProviderTerms,
    }: CreateProviderConnectionInput): Promise<ProviderConnectionView> => {
      setIsPending(true)
      try {
        const connection = await oxyServices.makeRequest<ProviderConnection>(
          'POST',
          `/inference/provider-connections/applications/${applicationId}`,
          { provider, environment, secret, acknowledgeProviderTerms },
          { retry: false, deduplicate: false },
        )
        return toProviderConnectionView(connection)
      } finally {
        // A lost Kaana acknowledgement deliberately returns an error after Oxy
        // has persisted a quarantined row. Refresh even on failure so Console
        // exposes the recovery action instead of hiding that durable state.
        await queryClient.invalidateQueries({
          queryKey: queryKeys.accountConnections(ownerAccountId),
        })
        setIsPending(false)
      }
    },
    [oxyServices, queryClient],
  )

  return { mutateAsync, isPending }
}

/**
 * Replace the credential behind an existing connection.
 *
 * The reference is unchanged, so a data plane holding it keeps working, and the
 * previous credential is gone the instant the store write lands.
 */
export function useRotateProviderConnection() {
  const { oxyServices } = useAuth()
  const queryClient = useQueryClient()
  const [isPending, setIsPending] = useState(false)

  const mutateAsync = useCallback(
    async ({
      connectionId,
      ownerAccountId,
      secret,
    }: {
      connectionId: string
      ownerAccountId: string
      secret: string
    }): Promise<ProviderConnectionView> => {
      setIsPending(true)
      try {
        const connection = await oxyServices.makeRequest<ProviderConnection>(
          'POST',
          `/inference/provider-connections/${connectionId}/rotate`,
          { secret },
          { retry: false, deduplicate: false },
        )
        return toProviderConnectionView(connection)
      } finally {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: queryKeys.accountConnections(ownerAccountId),
          }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.audit(connectionId),
          }),
        ])
        setIsPending(false)
      }
    },
    [oxyServices, queryClient],
  )

  return { mutateAsync, isPending }
}

/**
 * Resolve an outcome-uncertain Kaana operation under its original operation ID.
 *
 * The first attempt may omit `secret`: Kaana's durable outcome is queried
 * before any replay. Only when Kaana explicitly reports no outcome does a
 * create/rotate recovery require the original credential. This remains
 * imperative so the optional credential never enters MutationCache, retry
 * variables or request-deduplication keys.
 */
export function useReconcileProviderConnection() {
  const { oxyServices } = useAuth()
  const queryClient = useQueryClient()
  const [isPending, setIsPending] = useState(false)

  const mutateAsync = useCallback(
    async ({
      connectionId,
      ownerAccountId,
      secret,
    }: {
      connectionId: string
      ownerAccountId: string
      secret?: string
    }): Promise<ProviderConnectionView> => {
      setIsPending(true)
      try {
        const connection = await oxyServices.makeRequest<ProviderConnection>(
          'POST',
          `/inference/provider-connections/${connectionId}/reconcile`,
          secret === undefined ? {} : { secret },
          { retry: false, deduplicate: false },
        )
        return toProviderConnectionView(connection)
      } finally {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: queryKeys.accountConnections(ownerAccountId),
          }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.audit(connectionId),
          }),
        ])
        setIsPending(false)
      }
    },
    [oxyServices, queryClient],
  )

  return { mutateAsync, isPending }
}

/**
 * Take a connection out of service, or put it back.
 *
 * Pure database work on the server — no Kaana control round trip — so "immediate"
 * does not depend on the availability of the thing being stopped. That is why
 * this lane keeps working in a deployment where create and rotate refuse.
 */
export function useSetProviderConnectionEnabled() {
  const { oxyServices } = useAuth()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({
      connectionId,
      enabled,
    }: {
      connectionId: string
      ownerAccountId: string
      enabled: boolean
    }): Promise<ProviderConnectionView> =>
      oxyServices
        .makeRequest<ProviderConnection>(
          'POST',
          `/inference/provider-connections/${connectionId}/${enabled ? 'enable' : 'disable'}`,
          {},
          { retry: false },
        )
        .then(toProviderConnectionView),
    onSuccess: (_connection, { connectionId, ownerAccountId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.accountConnections(ownerAccountId),
      })
      queryClient.invalidateQueries({ queryKey: queryKeys.audit(connectionId) })
    },
  })
}

/**
 * Retire a connection permanently and destroy the stored credential.
 *
 * A destroy failure does not block the revoke — retiring a connection is a
 * safety operation, often because the key leaked — so the connection's audit
 * trail, not this call, is where "was the secret actually destroyed" is
 * answered. There is no delete: a deleted connection would make a past charge
 * unexplainable and would take its own trail with it.
 */
export function useRevokeProviderConnection() {
  const { oxyServices } = useAuth()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({
      connectionId,
    }: {
      connectionId: string
      ownerAccountId: string
    }): Promise<ProviderConnectionView> =>
      oxyServices
        .makeRequest<ProviderConnection>(
          'POST',
          `/inference/provider-connections/${connectionId}/revoke`,
          {},
          { retry: false },
        )
        .then(toProviderConnectionView),
    onSuccess: (_connection, { connectionId, ownerAccountId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.accountConnections(ownerAccountId),
      })
      queryClient.invalidateQueries({ queryKey: queryKeys.audit(connectionId) })
    },
  })
}
