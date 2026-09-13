/** @jest-environment node */
import { EventEmitter } from 'node:events';
import { createTrafficCollector, instrumentTrafficFetch, trafficMiddleware, trafficType, type TrafficAggregate } from '../collector';

describe('ecosystem activity collector', () => {
  it('reports all products independently of dashboard viewers and counts errors too', async () => {
    const batches: TrafficAggregate[][] = [];
    const collector = createTrafficCollector(async events => { batches.push(events); });
    for (const service of ['website', 'mention', 'mercaria', 'alia', 'kaana']) {
      const response = new EventEmitter();
      trafficMiddleware(collector, service, 'us-west-2')({ path: '/api/files/private-id', headers: { 'cf-ray': 'example-NRT', authorization: 'secret' } }, response, () => {});
      response.emit('finish');
      response.emit('close');
    }
    await collector.flush();
    expect(batches[0]).toHaveLength(10);
    expect(batches[0].filter(event => event.direction === 'inbound')).toHaveLength(5);
    expect(batches[0].every(event => event.activityType === 'media')).toBe(true);
    expect(JSON.stringify(batches)).not.toMatch(/private-id|secret|authorization/);
  });

  it('keeps scope, direction and category independent for co-located internal services', async () => {
    const batches: TrafficAggregate[][] = [];
    const collector = createTrafficCollector(async events => { batches.push(events); });
    const response = new EventEmitter();
    const request = { path: '/v1/chat/completions', headers: { 'x-oxy-source-region': 'us-west-2' }, serviceApp: undefined as undefined | { appName: string } };
    trafficMiddleware(collector, 'kaana', 'us-west-2')(request, response, () => { request.serviceApp = { appName: 'oxy-api' }; });
    response.emit('finish');
    await collector.flush();
    expect(batches[0]).toEqual([
      expect.objectContaining({ sourceRegion: 'us-west-2', targetRegion: 'us-west-2', sourceService: 'oxy-api', targetService: 'kaana', direction: 'inbound', scope: 'internal', activityType: 'ai' }),
      expect.objectContaining({ sourceService: 'kaana', targetService: 'oxy-api', direction: 'outbound', scope: 'internal', activityType: 'ai' }),
    ]);
  });

  it('does not fabricate a response on abort and excludes telemetry control traffic', async () => {
    const batches: TrafficAggregate[][] = [];
    const collector = createTrafficCollector(async events => { batches.push(events); });
    for (const path of ['/health', '/api/ready', '/platform-stats/stream', '/internal/activity']) {
      const response = new EventEmitter();
      trafficMiddleware(collector, 'website', 'us-west-2')({ path, headers: {} }, response, () => {});
      response.emit('finish');
    }
    const aborted = new EventEmitter();
    trafficMiddleware(collector, 'mention', 'us-west-2')({ path: '/messages', headers: {} }, aborted, () => {});
    aborted.emit('close');
    await collector.flush();
    expect(batches[0]).toHaveLength(1);
    expect(batches[0][0].direction).toBe('inbound');
  });

  it('tracks real outgoing calls and only reports the response when one arrived', async () => {
    const batches: TrafficAggregate[][] = [];
    const collector = createTrafficCollector(async events => { batches.push(events); });
    const fetcher = instrumentTrafficFetch(jest.fn(async () => new Response('ok', { headers: { 'X-Oxy-Region': 'eu-central-1' } })) as unknown as typeof fetch, collector, 'alia', 'us-west-2', url => url.hostname === 'api.oxy.so' ? { service: 'oxy-api', region: 'us-west-2' } : undefined);
    await fetcher('https://api.oxy.so/v1/chat/completions');
    await collector.flush();
    expect(batches[0].map(event => event.direction)).toEqual(['outbound', 'inbound']);
    expect(batches[0].every(event => event.scope === 'internal')).toBe(true);
    expect(batches[0][0].targetRegion).toBe('eu-central-1');
    expect(batches[0][1].sourceRegion).toBe('eu-central-1');
    const failed = instrumentTrafficFetch(jest.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch, collector, 'alia', 'us-west-2', () => undefined);
    await expect(failed('https://example.com/files')).rejects.toThrow('offline');
    await collector.flush();
    expect(batches[1]).toHaveLength(1);
    expect(batches[1][0]).toMatchObject({ scope: 'external', direction: 'outbound', activityType: 'media' });
  });

  it('chunks a busy fleet into ingestible batches and preserves fetch extensions', async () => {
    const batches: TrafficAggregate[][] = [];
    const collector = createTrafficCollector(async events => { batches.push(events); });
    for (let index = 0; index < 300; index++) collector.record({ region: 'us-west-2', service: `service-${index}`, scope: 'internal', direction: 'inbound', activityType: 'platform' });
    await collector.flush();
    expect(batches.map(batch => batch.length)).toEqual([256, 44]);
    const preconnect = jest.fn();
    const baseFetch = Object.assign(jest.fn(async () => new Response()), { preconnect }) as unknown as typeof fetch;
    const wrapped = instrumentTrafficFetch(baseFetch, collector, 'website', 'us-west-2', () => undefined);
    expect((wrapped as typeof baseFetch & { preconnect: unknown }).preconnect).toBe(preconnect);
  });

  it('keeps verified internal attribution when a request aborts', async () => {
    const batches: TrafficAggregate[][] = [];
    const collector = createTrafficCollector(async events => { batches.push(events); });
    const response = new EventEmitter();
    trafficMiddleware(collector, 'oxy-api', 'us-west-2')({ path: '/messages', headers: { 'x-oxy-source-region': 'eu-west-1' }, serviceApp: { appName: 'mention' } }, response, () => {});
    response.emit('close');
    await collector.flush();
    expect(batches[0]).toEqual([expect.objectContaining({ scope: 'internal', direction: 'inbound', sourceRegion: 'eu-west-1', sourceService: 'mention' })]);
  });

  it('classifies versioned media and inference endpoints without retaining the path', () => {
    expect(trafficType('/api/v1/uploads/private-id?token=secret')).toBe('media');
    expect(trafficType('/v1/chat/completions')).toBe('ai');
  });
});
