/** @jest-environment node */
import { isObservedPath } from '../collector';
import {
  OXY_ACTIVITY_ID_HEADER,
  OXY_EDGE_REGION_HEADER,
  OXY_REGION_HEADER,
  OXY_SOURCE_REGION_HEADER,
  OXY_TELEMETRY_EXPOSED_HEADERS,
  OXY_TELEMETRY_REQUEST_HEADERS,
} from '../index';
import { createEmfPublisherIfDeployed } from '../metrics';
import { metadataFromHeaders, sourceRegionFromEdgePop } from '../server';

describe('telemetry header lists', () => {
  it('request headers are exactly the headers a browser sends', () => {
    expect([...OXY_TELEMETRY_REQUEST_HEADERS]).toEqual([
      OXY_ACTIVITY_ID_HEADER,
      OXY_EDGE_REGION_HEADER,
    ]);
    expect(OXY_TELEMETRY_REQUEST_HEADERS).not.toContain(OXY_SOURCE_REGION_HEADER);
  });

  it('exposed headers are exactly the response headers a browser reads', () => {
    expect([...OXY_TELEMETRY_EXPOSED_HEADERS]).toEqual([OXY_REGION_HEADER]);
  });

  it('the server reads the same headers the constants name', () => {
    expect(
      metadataFromHeaders({
        [OXY_EDGE_REGION_HEADER.toLowerCase()]: 'MAD',
        [OXY_ACTIVITY_ID_HEADER.toLowerCase()]: 'anonymous-runtime-a1',
      }),
    ).toEqual({ edgePop: 'mad', activityId: 'anonymous-runtime-a1' });
  });
});

describe('isObservedPath', () => {
  it.each([
    ['/health', false],
    ['/health/deep', false],
    ['/api/health', false],
    ['/ready', false],
    ['/api/ready', false],
    ['/live', false],
    ['/platform-stats/stream', false],
    ['/platform-activity', false],
    ['/platform-infrastructure', false],
    ['/api/platform-infrastructure', false],
    ['/infra-status', false],
    ['/internal/activity', false],
    ['/internal/activity/batch', false],
    ['/auth/service-token', false],
    ['/cdn-cgi/trace', false],
    ['/healthy', true],
    ['/readyz', true],
    ['/users/me', true],
    ['/api/v1/users', true],
    ['/auth/session', true],
    ['/', true],
    ['/cdn-cgi', true],
  ])('%s -> observed: %s', (path, observed) => {
    expect(isObservedPath(path)).toBe(observed);
  });
});

describe('sourceRegionFromEdgePop', () => {
  it('prefixes a PoP and passes absence through', () => {
    expect(sourceRegionFromEdgePop('mad')).toBe('edge-mad');
    expect(sourceRegionFromEdgePop(undefined)).toBeUndefined();
    expect(sourceRegionFromEdgePop('')).toBeUndefined();
  });
});

describe('createEmfPublisherIfDeployed', () => {
  const options = { namespace: 'Oxy/Test', service: 'svc', write: () => {} };

  it('returns null off ECS', () => {
    expect(createEmfPublisherIfDeployed(options, {})).toBeNull();
    expect(createEmfPublisherIfDeployed(options, { ECS_CONTAINER_METADATA_URI_V4: '' })).toBeNull();
  });

  it('returns a publisher on ECS', () => {
    const publisher = createEmfPublisherIfDeployed(options, {
      ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/task',
    });
    expect(publisher).not.toBeNull();
    publisher?.stop();
  });

  it('reads process.env by default', () => {
    const previous = process.env.ECS_CONTAINER_METADATA_URI_V4;
    delete process.env.ECS_CONTAINER_METADATA_URI_V4;
    try {
      expect(createEmfPublisherIfDeployed(options)).toBeNull();
    } finally {
      if (previous !== undefined) process.env.ECS_CONTAINER_METADATA_URI_V4 = previous;
    }
  });
});

describe('instrumentTrafficFetch exclusion', () => {
  it('does not observe probe or control requests, and still observes the rest', async () => {
    const { createTrafficCollector, instrumentTrafficFetch } = await import('../collector');
    const published: unknown[][] = [];
    const collector = createTrafficCollector(async (events) => {
      published.push(events);
    });
    const fetcher = jest.fn(async () => new Response('ok')) as unknown as typeof fetch;
    const observed = instrumentTrafficFetch(
      fetcher,
      collector,
      'svc',
      'us-west-2',
      () => undefined,
    );
    await observed('https://example.com/health');
    await observed('https://example.com/cdn-cgi/trace');
    await collector.flush();
    expect(published).toHaveLength(0);
    await observed('https://example.com/users/me');
    await collector.flush();
    expect(published).toHaveLength(1);
  });
});
