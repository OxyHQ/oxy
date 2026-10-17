import { createEmfPublisher, HTTP_REQUEST_LATENCY, HTTP_RATE_LIMITED } from '../metrics';

describe('EMF publisher', () => {
  it('folds an interval into one EMF line per series with bounded dimensions', () => {
    const lines: string[] = [];
    const publisher = createEmfPublisher({
      namespace: 'Oxy/Test',
      service: 'svc',
      write: (line) => lines.push(line),
      now: () => 1_000,
      maxSeries: 2,
    });
    const labels = { Route: '/users/:id', StatusClass: '2xx', Caller: 'anonymous' };
    for (const ms of [10, 10, 200]) publisher.record(HTTP_REQUEST_LATENCY, ms, labels);
    publisher.record(HTTP_RATE_LIMITED, 1, { Caller: 'service:app' });
    // A third series exceeds maxSeries and folds into `other`.
    publisher.record(HTTP_RATE_LIMITED, 1, { Caller: 'service:another' });
    publisher.stop();

    const [latency, limited, overflow] = lines.map((line) => JSON.parse(line));
    expect(latency._aws).toEqual({
      Timestamp: 1_000,
      CloudWatchMetrics: [
        {
          Namespace: 'Oxy/Test',
          Dimensions: [['Service'], ['Service', 'StatusClass'], ['Service', 'Caller']],
          Metrics: [{ Name: 'RequestLatency', Unit: 'Milliseconds' }],
        },
      ],
    });
    expect(latency).toMatchObject({ Service: 'svc', Route: '/users/:id', StatusClass: '2xx' });
    // Values are ~5 % buckets; Count/Sum/Min/Max stay exact.
    expect(latency.RequestLatency.Values).toEqual([9.91, 204]);
    expect(latency.RequestLatency).toMatchObject({
      Counts: [2, 1],
      Max: 200,
      Min: 10,
      Count: 3,
      Sum: 220,
    });
    expect(limited).toMatchObject({ Caller: 'service:app', RateLimited: 1 });
    expect(overflow).toMatchObject({ Caller: 'other', RateLimited: 1 });
    expect(lines).toHaveLength(3);
  });
});
