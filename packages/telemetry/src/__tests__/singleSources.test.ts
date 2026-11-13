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

// The pre-change behaviour, copied verbatim from origin/main collector.ts
// (middleware lines 119-124, instrumentTrafficFetch lines 200-202).
const legacyInboundExcluded = (path: string): boolean =>
  /^\/(?:api\/)?(?:health|ready|live|platform-stats|platform-activity|platform-infrastructure|infra-status)(?:\/|$)/.test(
    path,
  ) ||
  path.startsWith('/internal/activity') ||
  path.startsWith('/auth/service-token') ||
  path.startsWith('/cdn-cgi/');
const legacyOutboundExcluded = (pathname: string): boolean =>
  pathname.startsWith('/internal/activity') ||
  pathname.startsWith('/auth/service-token') ||
  pathname === '/platform-infrastructure';

const PATHS = [
  '/',
  '/users/me',
  '/api/v1/users',
  '/auth/session',
  '/healthy',
  '/readyz',
  '/cdn-cgi',
  '/health',
  '/health/deep',
  '/health?x=1',
  '/api/health',
  '/api/health/x',
  '/ready',
  '/api/ready',
  '/live',
  '/api/live',
  '/platform-stats',
  '/platform-stats/stream',
  '/api/platform-stats',
  '/platform-activity',
  '/platform-activity/x',
  '/api/platform-activity',
  '/infra-status',
  '/infra-status/x',
  '/api/infra-status',
  '/platform-infrastructure',
  '/platform-infrastructure/',
  '/platform-infrastructure/x',
  '/api/platform-infrastructure',
  '/api/platform-infrastructure/x',
  '/platform-infrastructures',
  '/api/api/health',
  '/internal/activity',
  '/internal/activity/batch',
  '/internal/activityx',
  '/auth/service-token',
  '/auth/service-token/x',
  '/auth/service-tokens',
  '/cdn-cgi/',
  '/cdn-cgi/trace',
  '/v1/health',
];

describe('isObservedPath', () => {
  it.each(PATHS)('%s matches the pre-change inbound behaviour', (path) => {
    expect(isObservedPath(path, 'inbound')).toBe(!legacyInboundExcluded(path));
  });

  it.each(PATHS)('%s matches the pre-change outbound behaviour', (path) => {
    expect(isObservedPath(path, 'outbound')).toBe(!legacyOutboundExcluded(path));
  });

  it('pins the excluded sets explicitly in both directions', () => {
    const excluded = (direction: 'inbound' | 'outbound') =>
      PATHS.filter((path) => !isObservedPath(path, direction));
    expect(excluded('outbound')).toEqual([
      '/platform-infrastructure',
      '/internal/activity',
      '/internal/activity/batch',
      '/internal/activityx',
      '/auth/service-token',
      '/auth/service-token/x',
      '/auth/service-tokens',
    ]);
    expect(excluded('inbound')).toEqual(PATHS.filter(legacyInboundExcluded));
    // Excluded inbound only today; recorded outbound. Unifying is an owner decision.
    expect(excluded('inbound').filter((path) => isObservedPath(path, 'outbound'))).toContain(
      '/platform-stats',
    );
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
  it('skips control requests and still records outbound calls to inbound-excluded paths', async () => {
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
    await observed('https://example.com/internal/activity');
    await observed('https://example.com/auth/service-token');
    await observed('https://example.com/platform-infrastructure');
    await collector.flush();
    expect(published).toHaveLength(0);
    // Recorded outbound today, though excluded inbound.
    await observed('https://example.com/platform-stats');
    await collector.flush();
    expect(published).toHaveLength(1);
  });
});
