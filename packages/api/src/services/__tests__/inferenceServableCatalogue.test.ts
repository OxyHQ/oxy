/**
 * A `servable` catalogue read lists only models a request could be admitted on
 * now; the publication cache tells Oxy which exact deployments Kaana serves.
 *
 * Every exclusion below has a positive control in the same world, so "nothing
 * was listed" can never pass for the wrong reason.
 */

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { inferenceDeploymentRoutingScores } from '../../db/schema';
import { insertCatalogueRoute } from '../../db/testServableEvidence';
import {
  CATALOGUED,
  listCatalogueForViewer,
  resolveCatalogueViewer,
} from '../inferenceCatalogue.service';
import {
  createDeploymentPublicationCache,
  type DeploymentLiveness,
  isDeploymentPublished,
} from '../kaanaDeploymentPublication.service';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

const INTERNAL_VIEWER = resolveCatalogueViewer({ type: 'internal', isInternal: true });
const NOT_CONFIGURED: DeploymentLiveness = { status: 'not-configured' };

function published(...ids: string[]): DeploymentLiveness {
  return { status: 'observed', snapshotId: 'snap', deploymentIds: new Set(ids), observedAt: Date.now() };
}

async function listedIds(liveness: DeploymentLiveness): Promise<string[]> {
  return (await listCatalogueForViewer(INTERNAL_VIEWER, { kind: 'servable', liveness })).map(
    (entry) => entry.modelId
  );
}

describe('servable catalogue reads', () => {
  it('lists a model with complete evidence and omits one with no price or score', async () => {
    const complete = await insertCatalogueRoute();
    const bare = await insertCatalogueRoute({ evidence: false });

    const ids = await listedIds(NOT_CONFIGURED);
    expect(ids).toContain(complete.modelId);
    expect(ids).not.toContain(bare.modelId);
    // The `catalogued` read is unchanged: both exist for the viewer.
    const all = (await listCatalogueForViewer(INTERNAL_VIEWER, CATALOGUED)).map((e) => e.modelId);
    expect(all).toEqual(expect.arrayContaining([complete.modelId, bare.modelId]));
  });

  it('omits a model whose only deployment Kaana does not publish', async () => {
    const live = await insertCatalogueRoute();
    const withheld = await insertCatalogueRoute();

    const ids = await listedIds(published(live.internalRouteId));
    expect(ids).toContain(live.modelId);
    expect(ids).not.toContain(withheld.modelId);
  });

  it('keeps a model listed while at least one of its deployments is published', async () => {
    const first = await insertCatalogueRoute();
    const second = await insertCatalogueRoute({ sameModelAs: first });

    expect(await listedIds(published(second.internalRouteId))).toContain(first.modelId);
    expect(await listedIds(published())).not.toContain(first.modelId);
  });

  it('omits a model whose only funding evidence is exhausted', async () => {
    const funded = await insertCatalogueRoute();
    const exhausted = await insertCatalogueRoute({ evidence: { fundingState: 'exhausted' } });

    const ids = await listedIds(NOT_CONFIGURED);
    expect(ids).toContain(funded.modelId);
    expect(ids).not.toContain(exhausted.modelId);
  });

  it('omits a model whose scorecard names a different price version', async () => {
    const good = await insertCatalogueRoute();
    const drifted = await insertCatalogueRoute();
    const other = await insertCatalogueRoute();
    const [otherScore] = await getDb()
      .select({ priceVersionId: inferenceDeploymentRoutingScores.priceVersionId })
      .from(inferenceDeploymentRoutingScores)
      .where(eq(inferenceDeploymentRoutingScores.deploymentId, other.internalRouteId));
    await getDb()
      .update(inferenceDeploymentRoutingScores)
      .set({ priceVersionId: otherScore.priceVersionId })
      .where(eq(inferenceDeploymentRoutingScores.deploymentId, drifted.internalRouteId));

    const ids = await listedIds(NOT_CONFIGURED);
    expect(ids).toContain(good.modelId);
    expect(ids).not.toContain(drifted.modelId);
  });

  it('lists nothing when Kaana publication cannot be observed', async () => {
    const route = await insertCatalogueRoute();
    expect(await listedIds(NOT_CONFIGURED)).toContain(route.modelId);
    expect(await listedIds({ status: 'unavailable' })).toEqual([]);
  });
});

describe('isDeploymentPublished', () => {
  it('answers from the observed snapshot, fails closed when unavailable', () => {
    expect(isDeploymentPublished(published('a'), 'a')).toBe(true);
    expect(isDeploymentPublished(published('a'), 'b')).toBe(false);
    expect(isDeploymentPublished(published('a'), null)).toBe(false);
    expect(isDeploymentPublished({ status: 'unavailable' }, 'a')).toBe(false);
    expect(isDeploymentPublished(NOT_CONFIGURED, 'a')).toBe(true);
  });
});

describe('the deployment publication cache', () => {
  function snapshot(ids: string[]) {
    return {
      snapshotId: `snap-${ids.join('-')}`,
      deployments: ids.map((deploymentId) => ({
        deploymentId,
        modelReference: 'pub/model@r1',
        provider: 'prv',
        regions: [],
      })),
    };
  }

  it('serves one read within the TTL and refreshes after it', async () => {
    let clock = 1_000;
    const reads: string[][] = [['a'], ['a', 'b']];
    const listPublishedDeployments = jest.fn(async () => snapshot(reads.shift() ?? []));
    const cache = createDeploymentPublicationCache(
      { listPublishedDeployments },
      { ttlMs: 100, maxStaleMs: 1_000, now: () => clock }
    );

    const first = await cache.current();
    await cache.current();
    expect(listPublishedDeployments).toHaveBeenCalledTimes(1);
    expect(first.status === 'observed' && [...first.deploymentIds]).toEqual(['a']);

    clock += 150;
    const second = await cache.current();
    expect(listPublishedDeployments).toHaveBeenCalledTimes(2);
    expect(second.status === 'observed' && [...second.deploymentIds]).toEqual(['a', 'b']);
  });

  it('serves the last observation while a failure is young, then fails closed', async () => {
    let clock = 0;
    let fail = false;
    const cache = createDeploymentPublicationCache(
      {
        listPublishedDeployments: async () => {
          if (fail) throw new Error('kaana down');
          return snapshot(['a']);
        },
      },
      { ttlMs: 10, maxStaleMs: 100, now: () => clock }
    );
    expect((await cache.current()).status).toBe('observed');

    fail = true;
    clock = 50;
    expect((await cache.current()).status).toBe('observed');
    clock = 200;
    expect((await cache.current()).status).toBe('unavailable');
  });

  it('is unavailable when the very first read fails', async () => {
    const cache = createDeploymentPublicationCache({
      listPublishedDeployments: async () => {
        throw new Error('kaana down');
      },
    });
    expect(await cache.current()).toEqual({ status: 'unavailable' });
  });
});
