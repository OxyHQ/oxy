import {
  createEmfPublisher,
  createEmfPublisherIfDeployed,
  type EmfPublisher,
} from '@oxy.so/telemetry/metrics';

/**
 * One shared EMF publisher per CloudWatch namespace (`@oxy.so/telemetry/metrics`),
 * created on first use. A publisher belongs to ONE namespace, and the lines of
 * `Oxy/Queues`, `Oxy/FileStorage` and `Oxy/FileLifecycle` come from different
 * modules, so they share this registry instead of each building its own.
 *
 * On ECS only (the `awslogs` driver is what turns a line into a metric): off ECS
 * `emfPublisher` returns `null` and the caller records nothing.
 *
 * Every line carries `Service`, and a consumer reads the series under that value,
 * so the value is a constant of the process that emits, never derived from
 * configuration an operator could change under an alarm.
 */
const publishers = new Map<string, EmfPublisher | null>();
let testWrite: ((line: string) => void) | undefined;

export function emfPublisher(namespace: string, service: string): EmfPublisher | null {
  const key = `${namespace}\u0000${service}`;
  if (!publishers.has(key)) {
    const options = { namespace, service };
    publishers.set(
      key,
      testWrite
        ? createEmfPublisher({ ...options, write: testWrite })
        : createEmfPublisherIfDeployed(options),
    );
  }
  return publishers.get(key) ?? null;
}

/** Test seam: publish to `write` regardless of ECS. `undefined` restores the default. */
export function useEmfWriterForTests(write: ((line: string) => void) | undefined): void {
  for (const publisher of publishers.values()) publisher?.stop();
  publishers.clear();
  testWrite = write;
}

/** A published line as a test reads it back. */
export interface ParsedEmfLine {
  _aws: {
    Timestamp: number;
    CloudWatchMetrics: Array<{
      Namespace: string;
      Dimensions: string[][];
      Metrics: Array<{ Name: string; Unit: string }>;
    }>;
  };
  [field: string]: unknown;
}
