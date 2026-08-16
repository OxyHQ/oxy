import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
import type { InferenceEnvironment, ProviderConnection } from '@oxyhq/contracts';
import type { ProviderConnectionView } from '@/lib/provider-connection';
import { toProviderConnectionView } from '@/lib/provider-connection';

// ===========================================================================
// BYOK provider connections (`/inference/provider-connections`, issue #972
// workstream 10).
//
// A customer registers their own upstream provider credential; Oxy keeps a
// reference to it and the metadata around it. Nothing in this file returns a
// credential, and the `select` on every read projects the response through
// `toProviderConnectionView`, which drops `secretRef` — so the secret's ADDRESS
// never even enters the React Query cache, let alone a component.
//
// The customer's credential travels in exactly one direction, in exactly two
// mutations (`create`, `rotate`), read out of component state and handed
// straight to the request. It is never a query key, never a cached value, and
// never retried: `retry: false` is what stops a refused write from re-sending a
// secret three more times over the following seconds — and the refusal these
// deployments actually produce is a `503 provider_secret_store_unavailable`,
// which the SDK's default retry policy WOULD retry, because it is a 5xx.
// ===========================================================================

/** One entry of a connection's append-only trail. */
export interface ProviderConnectionAuditEvent {
  readonly eventType:
    | 'created'
    | 'validated'
    | 'rotated'
    | 'used'
    | 'disabled'
    | 'enabled'
    | 'revoked';
  /** Null for an event a service credential caused — there is no person behind one. */
  readonly actorUserId: string | null;
  readonly environment: string;
  readonly createdAt: string;
}

const queryKeys = {
  accountConnections: (accountId: string) => ['provider-connections', accountId] as const,
  audit: (connectionId: string) => ['provider-connection-audit', connectionId] as const,
};

/**
 * Every connection an account owns — its own, its projects', and its
 * applications'.
 *
 * Requires `account:read` on that account, which is baseline for every role, so
 * the caller gate is a real permission read and not a role name.
 */
export function useAccountProviderConnections(
  accountId: string | undefined,
  enabled: boolean = true
) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.accountConnections(accountId ?? ''),
    queryFn: () =>
      oxyServices.makeRequest<Array<ProviderConnection>>(
        'GET',
        `/inference/provider-connections/accounts/${accountId ?? ''}`,
        undefined,
        { cache: false }
      ),
    select: (connections): Array<ProviderConnectionView> =>
      connections.map(toProviderConnectionView),
    enabled: isReady && isAuthenticated && !!accountId && enabled,
    staleTime: 1000 * 30,
    retry: 1,
  });
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
  enabled: boolean = true
) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.audit(connectionId ?? ''),
    queryFn: () =>
      oxyServices.makeRequest<Array<ProviderConnectionAuditEvent & { metadata?: unknown }>>(
        'GET',
        `/inference/provider-connections/${connectionId ?? ''}/audit`,
        { limit },
        { cache: false }
      ),
    select: (events): Array<ProviderConnectionAuditEvent> =>
      events.map((event) => ({
        eventType: event.eventType,
        actorUserId: event.actorUserId,
        environment: event.environment,
        createdAt: event.createdAt,
      })),
    enabled: isReady && isAuthenticated && !!connectionId && enabled,
    staleTime: 1000 * 30,
    retry: 1,
  });
}

/** What the create form collects. `secret` is the customer's own upstream credential. */
export interface CreateProviderConnectionInput {
  applicationId: string;
  ownerAccountId: string;
  provider: string;
  environment: InferenceEnvironment;
  secret: string;
  acknowledgeProviderTerms: boolean;
}

/**
 * Register a credential scoped to one application.
 *
 * The owning account is resolved SERVER-side from the application; the
 * `ownerAccountId` carried on the input is only the cache key to invalidate.
 */
export function useCreateApplicationProviderConnection() {
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      applicationId,
      provider,
      environment,
      secret,
      acknowledgeProviderTerms,
    }: CreateProviderConnectionInput): Promise<ProviderConnectionView> =>
      oxyServices
        .makeRequest<ProviderConnection>(
          'POST',
          `/inference/provider-connections/applications/${applicationId}`,
          { provider, environment, secret, acknowledgeProviderTerms },
          { retry: false }
        )
        .then(toProviderConnectionView),
    onSuccess: (_connection, { ownerAccountId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.accountConnections(ownerAccountId) });
    },
  });
}

/**
 * Replace the credential behind an existing connection.
 *
 * The reference is unchanged, so a data plane holding it keeps working, and the
 * previous credential is gone the instant the store write lands.
 */
export function useRotateProviderConnection() {
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      connectionId,
      secret,
    }: {
      connectionId: string;
      ownerAccountId: string;
      secret: string;
    }): Promise<ProviderConnectionView> =>
      oxyServices
        .makeRequest<ProviderConnection>(
          'POST',
          `/inference/provider-connections/${connectionId}/rotate`,
          { secret },
          { retry: false }
        )
        .then(toProviderConnectionView),
    onSuccess: (_connection, { connectionId, ownerAccountId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.accountConnections(ownerAccountId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.audit(connectionId) });
    },
  });
}

/**
 * Take a connection out of service, or put it back.
 *
 * Pure database work on the server — no secret store round trip — so "immediate"
 * does not depend on the availability of the thing being stopped. That is why
 * this lane keeps working in a deployment where create and rotate refuse.
 */
export function useSetProviderConnectionEnabled() {
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      connectionId,
      enabled,
    }: {
      connectionId: string;
      ownerAccountId: string;
      enabled: boolean;
    }): Promise<ProviderConnectionView> =>
      oxyServices
        .makeRequest<ProviderConnection>(
          'POST',
          `/inference/provider-connections/${connectionId}/${enabled ? 'enable' : 'disable'}`,
          {},
          { retry: false }
        )
        .then(toProviderConnectionView),
    onSuccess: (_connection, { connectionId, ownerAccountId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.accountConnections(ownerAccountId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.audit(connectionId) });
    },
  });
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
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      connectionId,
    }: {
      connectionId: string;
      ownerAccountId: string;
    }): Promise<ProviderConnectionView> =>
      oxyServices
        .makeRequest<ProviderConnection>(
          'POST',
          `/inference/provider-connections/${connectionId}/revoke`,
          {},
          { retry: false }
        )
        .then(toProviderConnectionView),
    onSuccess: (_connection, { connectionId, ownerAccountId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.accountConnections(ownerAccountId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.audit(connectionId) });
    },
  });
}
