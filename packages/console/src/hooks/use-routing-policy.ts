import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
import type { InferenceRouteSwitchReason, RoutingPolicy } from '@oxyhq/contracts';
import type { RoutingPolicyControls, StoredRoutingPolicy } from '@/lib/routing-policy';

// ===========================================================================
// The routing policy control plane (`/inference/routing-policies`, issue #972
// workstream 6).
//
// A customer configures which providers, regions, licences, prices and
// fallbacks they will accept; the data plane executes it. Nothing here routes a
// request.
//
// Two things about these reads are deliberate:
//
//  - `cache: false` on every GET. The SDK's `HttpService` keeps its own response
//    cache keyed on method+url, which React Query invalidation cannot reach — so
//    a policy edited here would keep reading back its previous version until
//    that TTL expired. React Query owns the caching for this surface; the SDK
//    cache is switched off rather than fought with.
//  - `retry: false` on every write. A write that fails does so because the
//    policy is contradictory, names something Oxy does not serve, or the caller
//    lacks the permission — none of which a second attempt changes.
//
// Permissions are the server's, always: the routes gate on `app:read` /
// `app:update` over the application (and `usage:read` for the route-switch
// record), derived from the caller's EFFECTIVE membership in the owning account.
// Callers read `useCallerAccess(application)` and never re-derive from a role.
// ===========================================================================

/** One recorded route switch, as `GET …/route-switches` returns it. */
export interface RouteSwitchEvent {
  readonly eventId: string;
  readonly requestId: string;
  readonly sequence: number;
  readonly applicationId: string;
  readonly routingPolicyVersionId: string;
  /** `deployment` is same-model failover; `model` is an authorised substitution. */
  readonly scope: 'deployment' | 'model';
  readonly reason: InferenceRouteSwitchReason;
  readonly requestedModelId: string | null;
  readonly fromModelReference: string;
  readonly toModelReference: string;
  readonly toProvider: string;
  readonly occurredAt: string;
}

const queryKeys = {
  effective: (applicationId: string) => ['routing-policy', applicationId] as const,
  versions: (policyId: string) => ['routing-policy-versions', policyId] as const,
  routeSwitches: (applicationId: string) => ['route-switches', applicationId] as const,
};

/**
 * The policy IN FORCE for an application: its own, or the account floor it
 * inherits, or `null` when neither exists.
 *
 * Which of the two it is reads off `policy.scope.kind` — see
 * `effectivePolicyOrigin`.
 */
export function useEffectiveRoutingPolicy(applicationId: string, enabled: boolean = true) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.effective(applicationId),
    queryFn: () =>
      oxyServices.makeRequest<StoredRoutingPolicy | null>(
        'GET',
        `/inference/routing-policies/applications/${applicationId}`,
        undefined,
        { cache: false }
      ),
    enabled: isReady && isAuthenticated && !!applicationId && enabled,
    staleTime: 1000 * 30,
    retry: 1,
  });
}

/**
 * Every version of a policy, newest first.
 *
 * This is the audit trail a charge is explained against: a receipt names a
 * version, and the constraints that were in force are read from here — never
 * from the policy as it exists now.
 */
export function useRoutingPolicyVersions(policyId: string | undefined, enabled: boolean = true) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.versions(policyId ?? ''),
    queryFn: () =>
      oxyServices.makeRequest<Array<StoredRoutingPolicy>>(
        'GET',
        `/inference/routing-policies/${policyId ?? ''}/versions`,
        undefined,
        { cache: false }
      ),
    enabled: isReady && isAuthenticated && !!policyId && enabled,
    staleTime: 1000 * 30,
    retry: 1,
  });
}

/**
 * The customer-visible record of every allowed route switch on this
 * application's requests.
 *
 * A cross-model entry exists only where the customer's own policy authorised
 * that destination by name — the row cannot be written otherwise.
 */
export function useRouteSwitchEvents(
  applicationId: string,
  limit: number = 50,
  enabled: boolean = true
) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.routeSwitches(applicationId),
    queryFn: () =>
      oxyServices.makeRequest<Array<RouteSwitchEvent>>(
        'GET',
        `/inference/routing-policies/applications/${applicationId}/route-switches`,
        { limit },
        { cache: false }
      ),
    enabled: isReady && isAuthenticated && !!applicationId && enabled,
    staleTime: 1000 * 30,
    retry: 1,
  });
}

/** Create the application's own policy. It wins over the account floor at once. */
export function useCreateApplicationRoutingPolicy() {
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      applicationId,
      controls,
    }: {
      applicationId: string;
      controls: RoutingPolicyControls;
    }): Promise<RoutingPolicy> =>
      oxyServices.makeRequest<RoutingPolicy>(
        'POST',
        `/inference/routing-policies/applications/${applicationId}`,
        controls,
        { retry: false }
      ),
    onSuccess: (_policy, { applicationId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.effective(applicationId) });
    },
  });
}

/**
 * The EDIT path: append the next version and make it current.
 *
 * A POST to a collection rather than a PATCH on the policy, because that is what
 * it does — the previous version is left byte-for-byte as it was, which is what
 * lets a settled receipt still name the configuration that produced it.
 */
export function useAppendRoutingPolicyVersion() {
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      policyId,
      controls,
    }: {
      policyId: string;
      applicationId: string;
      controls: RoutingPolicyControls;
    }): Promise<RoutingPolicy> =>
      oxyServices.makeRequest<RoutingPolicy>(
        'POST',
        `/inference/routing-policies/${policyId}/versions`,
        controls,
        { retry: false }
      ),
    onSuccess: (_policy, { policyId, applicationId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.effective(applicationId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.versions(policyId) });
    },
  });
}

/**
 * Retire a policy.
 *
 * There is deliberately no delete: a DELETE that archived would be a lie, and a
 * DELETE that deleted would let a customer make a past charge unexplainable.
 */
export function useArchiveRoutingPolicy() {
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      policyId,
    }: {
      policyId: string;
      applicationId: string;
    }): Promise<{ routingPolicyId: string; status: string }> =>
      oxyServices.makeRequest<{ routingPolicyId: string; status: string }>(
        'POST',
        `/inference/routing-policies/${policyId}/archive`,
        {},
        { retry: false }
      ),
    onSuccess: (_result, { policyId, applicationId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.effective(applicationId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.versions(policyId) });
    },
  });
}
