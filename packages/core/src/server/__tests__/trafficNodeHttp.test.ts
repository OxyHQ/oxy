import http from 'node:http';
import { once } from 'node:events';
import { observeNodeHttp, withoutNodeHttpObservation } from '../trafficNodeHttp';
import type { TrafficFlow } from '@oxy.so/telemetry/collector';

it('observes real HTTP clients, preserves behavior and restores the HTTP facade', async () => {
  const events: TrafficFlow[] = [];
  const original = http.request;
  const server = http.createServer((_req, res) => { res.setHeader('X-Oxy-Region', 'eu-west-1'); res.end('ok'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const stop = observeNodeHttp({ record: flow => events.push(flow) }, 'website', 'us-west-2', () => ({ service: 'oxy-api', region: 'unknown' }));
  const request = (path: string) => new Promise<void>((resolve, reject) => {
    const outgoing = http.get(`http://127.0.0.1:${port}${path}`, response => { response.resume(); response.on('end', resolve); });
    // The observer must not swallow an unhandled request error.
    expect(outgoing.listenerCount('error')).toBe(0);
    outgoing.once('error', reject);
  });
  try {
    // Bun leaves Host implicit: its ClientRequest.host is the available authority.
    const getHeader = http.ClientRequest.prototype.getHeader;
    http.ClientRequest.prototype.getHeader = function (name: string) { return name === 'host' ? undefined : getHeader.call(this, name); };
    try { await request('/files/private-id'); } finally { http.ClientRequest.prototype.getHeader = getHeader; }
    expect(events).toEqual([
      expect.objectContaining({ scope: 'internal', direction: 'outbound', activityType: 'media', sourceRegion: 'us-west-2', targetRegion: 'eu-west-1' }),
      expect.objectContaining({ scope: 'internal', direction: 'inbound', sourceRegion: 'eu-west-1', targetRegion: 'us-west-2' }),
    ]);
    expect(JSON.stringify(events)).not.toContain('private-id');
    await withoutNodeHttpObservation(() => request('/files/no-double-count'));
    await request('/internal/activity');
    expect(events).toHaveLength(2);
    stop();
    expect(http.request).toBe(original);
    await request('/files/after-stop');
    expect(events).toHaveLength(2);
  } finally { stop(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
