import { PerformanceMonitor } from '../performanceMonitor';

describe('PerformanceMonitor', () => {
  let monitor: PerformanceMonitor;

  beforeEach(() => {
    monitor = new PerformanceMonitor();
  });

  afterEach(() => {
    monitor.stop();
  });

  it('keeps a bounded recent-metric ring in chronological order', () => {
    for (let index = 0; index < 1_010; index += 1) {
      monitor.recordMetric('GET /items/:id', index);
    }

    const metrics = monitor.getRecentMetrics(1_500);
    expect(metrics).toHaveLength(1_000);
    expect(metrics[0]?.duration).toBe(10);
    expect(metrics.at(-1)?.duration).toBe(1_009);
  });

  it('calculates percentiles only when statistics are read', () => {
    for (const duration of [10, 20, 30, 40, 50]) {
      monitor.recordMetric('GET /health', duration);
    }

    expect(monitor.getOperationStats('GET /health')).toMatchObject({
      count: 5,
      p50: 30,
      p95: 50,
      p99: 50,
    });
  });

  it('bounds operation cardinality', () => {
    for (let index = 0; index < 520; index += 1) {
      monitor.recordMetric(`GET /route-${index}`, 1);
    }

    expect(monitor.getStats()).toHaveLength(513);
    expect(monitor.getOperationStats('other')?.count).toBe(8);
  });
});
