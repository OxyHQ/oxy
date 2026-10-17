import express from 'express';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EmfPublisher, MetricDefinition } from '@oxy.so/telemetry/metrics';
import { rateLimit } from '../rateLimiter';
import { createRouteMetricsMiddleware } from '../routeMetrics';

describe('route metrics', () => {
  it('records the route template, status class, caller and the refusing limiter', async () => {
    const records: { metric: string; value: number; labels?: Readonly<Record<string, string>> }[] =
      [];
    const publisher: EmfPublisher = {
      record: (metric: MetricDefinition, value, labels) =>
        records.push({ metric: metric.name, value, labels }),
      flush: () => {},
      stop: () => {},
    };
    const app = express();
    app.use(createRouteMetricsMiddleware(publisher));
    const router = express.Router();
    router.get(
      '/items/:id',
      rateLimit({ prefix: 'rl:test:route-metrics:', windowMs: 60_000, max: 1 }),
      (_req, res) => {
        res.json({ ok: true });
      },
    );
    app.use('/things', router);

    const server = await new Promise<http.Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    try {
      const { port } = server.address() as AddressInfo;
      for (const id of ['private-1', 'private-2']) {
        await (await fetch(`http://127.0.0.1:${port}/things/items/${id}`)).text();
      }
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    const shared = { Route: '/things/items/:id', Method: 'GET', Caller: 'anonymous' };
    expect(records.map(({ metric, labels }) => ({ metric, labels }))).toEqual([
      { metric: 'RequestLatency', labels: { ...shared, StatusClass: '2xx' } },
      { metric: 'RequestLatency', labels: { ...shared, StatusClass: '4xx' } },
      {
        metric: 'RateLimited',
        labels: { ...shared, StatusClass: '4xx', Limiter: 'rl:test:route-metrics:' },
      },
    ]);
  });
});
