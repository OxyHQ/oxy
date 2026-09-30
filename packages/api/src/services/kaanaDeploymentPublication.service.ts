/**
 * Which exact Kaana deployments the data plane is publishing RIGHT NOW.
 *
 * ## Why Oxy needs this beside the catalogue sync
 *
 * Kaana withholds a deployment from its serving snapshot when it cannot serve
 * it — an exhausted or disabled credential, a sustained upstream failure. The
 * catalogue sync (`kaanaCatalogueSync.service.ts`) eventually retires such a
 * route, but only on its 30-minute cadence and never when the retirement would
 * look like a broken report. In between, `/v1/models` would list a model no
 * request can reach, and a routing profile could choose it: the edge's exact
 * attestation then refuses the WHOLE request with a 503 because one authorized
 * id is missing from the snapshot.
 *
 * So the catalogue and the edge read this short-lived view of the snapshot and
 * treat an unpublished deployment exactly like a retired one: not listed, not
 * chosen. It is an AVAILABILITY fact, like capacity — it narrows the candidate
 * set before any selection, and it is never a selector itself. The exact
 * per-request attestation stays the identity proof (the snapshot can move
 * between this read and execution).
 *
 * ## Freshness, and failing closed
 *
 * One signed read of the whole snapshot (`POST /internal/v1/deployments/query`
 * with `{}`) is cached for {@link PUBLICATION_TTL_MS}, single-flight. If a
 * refresh fails, the last observation keeps being served until it is
 * {@link PUBLICATION_MAX_STALE_MS} old; after that the answer is `unavailable`
 * and callers fail closed — the catalogue lists nothing and the edge refuses —
 * because "we cannot tell what Kaana serves" is not "Kaana serves everything".
 *
 * `undefined` source (see {@link deploymentPublicationSource}) means THIS
 * process has no Kaana binding at all. The edge cannot execute anything in that
 * state either (it refuses `kaana-not-configured` before a hold), so the
 * catalogue applies only Oxy's own evidence filter there. Both the source and
 * the edge's client come from the same `resolveKaanaDataPlane()` resolution, so
 * production cannot have one without the other.
 */

import type { KaanaDeploymentAttestation } from './kaanaClient';
import { createHttpKaanaCatalogueReader } from './httpKaanaClient';
import { logger } from '../utils/logger';

export const PUBLICATION_TTL_MS = 15_000;
export const PUBLICATION_MAX_STALE_MS = 120_000;
const PUBLICATION_READ_TIMEOUT_MS = 5_000;

/** One observation of Kaana's serving snapshot, or the honest lack of one. */
export type DeploymentPublication =
  | {
      readonly status: 'observed';
      readonly snapshotId: string;
      /** Exact `deploymentId`s (Oxy's `internal_route_id`) the snapshot publishes. */
      readonly deploymentIds: ReadonlySet<string>;
      readonly observedAt: number;
    }
  | { readonly status: 'unavailable' };

/**
 * What a reader of availability is handed. `not-configured` is stated by name
 * rather than passed as `undefined`, so "this process has no data plane" is a
 * decision in the caller's source rather than a missing argument.
 */
export type DeploymentLiveness = DeploymentPublication | { readonly status: 'not-configured' };

export interface DeploymentPublicationSource {
  current(): Promise<DeploymentPublication>;
}

export interface PublishedDeploymentReader {
  listPublishedDeployments(signal: AbortSignal): Promise<KaanaDeploymentAttestation>;
}

/** Whether an exact deployment id may be offered under this liveness view. */
export function isDeploymentPublished(
  liveness: DeploymentLiveness,
  deploymentId: string | null
): boolean {
  if (liveness.status === 'not-configured') return true;
  if (liveness.status === 'unavailable') return false;
  return deploymentId !== null && liveness.deploymentIds.has(deploymentId);
}

export function createDeploymentPublicationCache(
  reader: PublishedDeploymentReader,
  options: {
    readonly ttlMs?: number;
    readonly maxStaleMs?: number;
    readonly now?: () => number;
  } = {}
): DeploymentPublicationSource {
  const ttlMs = options.ttlMs ?? PUBLICATION_TTL_MS;
  const maxStaleMs = options.maxStaleMs ?? PUBLICATION_MAX_STALE_MS;
  const now = options.now ?? Date.now;
  let last: Extract<DeploymentPublication, { status: 'observed' }> | undefined;
  let inFlight: Promise<DeploymentPublication> | undefined;

  const refresh = async (): Promise<DeploymentPublication> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUBLICATION_READ_TIMEOUT_MS);
    try {
      const snapshot = await reader.listPublishedDeployments(controller.signal);
      last = {
        status: 'observed',
        snapshotId: snapshot.snapshotId,
        deploymentIds: new Set(snapshot.deployments.map((deployment) => deployment.deploymentId)),
        observedAt: now(),
      };
      return last;
    } catch (error) {
      logger.warn('inference.kaana.publication_read_failed', {
        component: 'inference-kaana',
        error: error instanceof Error ? error.message : String(error),
        lastObservedAt: last?.observedAt,
      });
      if (last !== undefined && now() - last.observedAt <= maxStaleMs) return last;
      return { status: 'unavailable' };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    current(): Promise<DeploymentPublication> {
      if (last !== undefined && now() - last.observedAt < ttlMs) return Promise.resolve(last);
      inFlight ??= refresh().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}

function configuredSource(): DeploymentPublicationSource | undefined {
  const reader = createHttpKaanaCatalogueReader();
  return reader === undefined ? undefined : createDeploymentPublicationCache(reader);
}

let source: DeploymentPublicationSource | undefined = configuredSource();

/** The process-wide source; `undefined` when no Kaana binding is configured. */
export function deploymentPublicationSource(): DeploymentPublicationSource | undefined {
  return source;
}

/** Read the current liveness view, naming the unconfigured case. */
export async function currentDeploymentLiveness(): Promise<DeploymentLiveness> {
  const configured = source;
  return configured === undefined ? { status: 'not-configured' } : configured.current();
}

/**
 * Replace the process-wide source (tests, and nothing else). Returns the
 * function that restores the previous one.
 */
export function overrideDeploymentPublicationSource(
  replacement: DeploymentPublicationSource | undefined
): () => void {
  const previous = source;
  source = replacement;
  return () => {
    source = previous;
  };
}
