import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
import type { ModelCatalogueEntry, RoutingProfile } from '@oxyhq/contracts';

// ===========================================================================
// The model catalogue — read from the real catalogue API (issue #972,
// workstream 5), not from the retired `/models/stats` envelope.
//
// Wire types come from `@oxyhq/contracts`, which is the schema the API parses
// its own output with (`modelCatalogueEntrySchema.parse(entry)` in
// `inferenceCatalogue.service.ts`). Producer and consumer therefore cannot
// drift: a field the server stops serving stops existing here too.
//
// This replaces the hand-written `ModelStats`, which typed five fields the API
// no longer serves at all — `tier`, `creditMultiplier`, `uptime`, `successRate`
// and `isHealthy`. Those were literals in the retired static array, and three of
// them describe deployment health, which Relay owns and the control plane cannot
// answer (ADR 0006). A type that promises them is a type that will read
// `undefined` as a real value the moment a model lands.
//
// Both endpoints are unauthenticated reads that resolve the PUBLIC audience for
// an ordinary caller, so neither is gated on a session. The catalogue is empty
// until workstream 5's seeding lands; an empty array is the honest answer and
// the pages render it as one.
// ===========================================================================

export type { ModelCatalogueEntry, RoutingProfile };

const queryKeys = {
  /** The customer-safe model catalogue. */
  catalogue: ['model-catalogue'] as const,
  /** Routing profiles — a separate collection with its own id space (ADR 0008). */
  routingProfiles: ['routing-profiles'] as const,
};

/**
 * `GET /models` — the customer-safe catalogue.
 *
 * `makeRequest` unwraps the `{ data, count }` envelope, so this resolves to the
 * entry array itself.
 */
export function useModelCatalogue() {
  const { oxyServices } = useAuth();

  return useQuery({
    queryKey: queryKeys.catalogue,
    queryFn: () => oxyServices.makeRequest<Array<ModelCatalogueEntry>>('GET', '/models'),
    staleTime: 1000 * 60 * 5,
    retry: 1,
  });
}

/**
 * `GET /models/routing-profiles` — profiles, which are policy objects and never
 * models. Rendered in their own section for exactly that reason.
 */
export function useRoutingProfiles() {
  const { oxyServices } = useAuth();

  return useQuery({
    queryKey: queryKeys.routingProfiles,
    queryFn: () =>
      oxyServices.makeRequest<Array<RoutingProfile>>('GET', '/models/routing-profiles'),
    staleTime: 1000 * 60 * 5,
    retry: 1,
  });
}
