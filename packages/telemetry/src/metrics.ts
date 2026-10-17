/**
 * Operational metrics for Oxy services, published as CloudWatch Embedded Metric
 * Format (EMF) log lines.
 *
 * WHY EMF ON STDOUT: every Oxy backend runs on ECS with the `awslogs` driver, and
 * CloudWatch Logs extracts metrics from any log event shaped as EMF — no agent,
 * no sidecar, no scraper, no IAM grant beyond the logging the task already has.
 * A registry that only an HTTP scrape can read (Prometheus) measures into a void
 * when nothing scrapes it, which is how Mention's counters lost every value on
 * every deploy.
 *
 * WHY AGGREGATED: values are folded in memory and flushed once per interval as
 * ONE line per (metric, label set), not one line per observation. A latency is
 * kept as a distribution (`Values`/`Counts`), so CloudWatch still answers
 * SampleCount, p50 and p99 for it — the request COUNT is the distribution's
 * SampleCount, so a service needs no separate counter for it.
 *
 * WHY MOST LABELS ARE NOT DIMENSIONS: every distinct combination of dimension
 * values is a billed custom metric. Route x method as dimensions once measured
 * 405 metrics and ~80 % of the account's CloudWatch bill (Mention #1334). So a
 * label becomes a DIMENSION only when a metric definition names it in
 * `dimensionSets`, and only labels with a small, closed value set belong there.
 * Every other label is written as a plain property of the line: free to store,
 * and grouped in Logs Insights (`stats sum(RequestLatency.Count) by Route`).
 */

export type MetricUnit =
  | 'Count'
  | 'Milliseconds'
  | 'Seconds'
  | 'Bytes'
  | 'Percent'
  | 'Count/Second'
  | 'None';

/**
 * `sum` adds every value in the interval (a counter), `distribution` keeps the
 * values for percentiles (a latency or a size), and `gauge` keeps the last one.
 */
export type MetricKind = 'sum' | 'distribution' | 'gauge';

export interface MetricDefinition {
  /** CloudWatch metric name; also the field holding its value on the line. */
  readonly name: string;
  readonly unit: MetricUnit;
  readonly kind: MetricKind;
  /**
   * Label names promoted to CloudWatch dimensions. Each inner list is one
   * dimension set, published IN ADDITION to the always-present `[Service]`
   * set. Only closed, small value sets belong here: each distinct combination
   * is a billed custom metric.
   */
  readonly dimensionSets?: readonly (readonly string[])[];
}

export type MetricLabels = Readonly<Record<string, string>>;

export interface EmfPublisherOptions {
  /** CloudWatch namespace, e.g. `Oxy/Api`. */
  readonly namespace: string;
  /** Value of the `Service` dimension every metric carries. */
  readonly service: string;
  /** Flush period. Default 60 s, CloudWatch's standard resolution. */
  readonly flushIntervalMs?: number;
  /**
   * Distinct (metric, label set) series held per interval. A label value that
   * traffic can mint must not be able to grow memory or log volume without
   * bound, so past this many every NEW series is folded into one whose labels
   * all read `other`. Default 2000.
   */
  readonly maxSeries?: number;
  /** Where each line goes. Default: one line on stdout. */
  readonly write?: (line: string) => void;
  /** Clock, for tests. */
  readonly now?: () => number;
}

export interface EmfPublisher {
  /** Fold one observation into the current interval. Never throws. */
  record(metric: MetricDefinition, value: number, labels?: MetricLabels): void;
  /** Write the current interval now and start a new one. */
  flush(): void;
  /** Flush and stop the timer, for graceful shutdown. */
  stop(): void;
}

/** One HTTP request: SampleCount is the request count, percentiles the latency. */
export const HTTP_REQUEST_LATENCY: MetricDefinition = {
  name: 'RequestLatency',
  unit: 'Milliseconds',
  kind: 'distribution',
  dimensionSets: [['StatusClass'], ['Caller']],
};

/** One request a rate limiter refused (429), per calling application. */
export const HTTP_RATE_LIMITED: MetricDefinition = {
  name: 'RateLimited',
  unit: 'Count',
  kind: 'sum',
  dimensionSets: [['Caller']],
};

/** `2xx`, `4xx`, … — a closed set, safe as a dimension. */
export function statusClass(status: number): string {
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? `${Math.floor(status / 100)}xx`
    : 'other';
}

/** EMF allows at most 100 distinct values per metric on one line. */
const MAX_DISTRIBUTION_VALUES = 100;
/** Neighbouring values within ~5 % share a bucket, which bounds the set. */
const BUCKET_BASE = 1.05;
const LABEL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_LABEL_VALUE_LENGTH = 128;
const RESERVED = new Set(['_aws', 'Service']);

interface Series {
  metric: MetricDefinition;
  labels: Record<string, string>;
  sum: number;
  last: number;
  count: number;
  min: number;
  max: number;
  buckets: Map<number, number>;
}

/** Representative value of a bucket: values within ~5 % collapse together. */
function bucketOf(value: number): number {
  if (value <= 0) return 0;
  const exponent = Math.round(Math.log(value) / Math.log(BUCKET_BASE));
  return Number((BUCKET_BASE ** exponent).toPrecision(3));
}

/** Merge adjacent buckets (keeping the larger value) until EMF accepts them. */
function boundedDistribution(buckets: Map<number, number>): { values: number[]; counts: number[] } {
  let entries = [...buckets.entries()].sort(([left], [right]) => left - right);
  while (entries.length > MAX_DISTRIBUTION_VALUES) {
    const merged: [number, number][] = [];
    for (let index = 0; index < entries.length; index += 2) {
      const [value, count] = entries[index];
      const next = entries[index + 1];
      merged.push(next ? [next[0], count + next[1]] : [value, count]);
    }
    entries = merged;
  }
  return { values: entries.map(([value]) => value), counts: entries.map(([, count]) => count) };
}

function cleanLabels(
  metric: MetricDefinition,
  labels: MetricLabels | undefined,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, raw] of Object.entries(labels ?? {})) {
    if (!LABEL_NAME.test(name) || RESERVED.has(name) || name === metric.name) continue;
    const value = String(raw).slice(0, MAX_LABEL_VALUE_LENGTH);
    clean[name] = value.length > 0 ? value : 'unknown';
  }
  // A dimension named by the definition must be present on every line, or
  // CloudWatch drops the metric from that line.
  for (const set of metric.dimensionSets ?? []) {
    for (const name of set) clean[name] ??= 'unknown';
  }
  return clean;
}

function seriesKey(metric: MetricDefinition, labels: Record<string, string>): string {
  const pairs = Object.keys(labels)
    .sort()
    .map((name) => `${name}=${labels[name]}`);
  return `${metric.name}\u0000${pairs.join('\u0000')}`;
}

function defaultWrite(line: string): void {
  if (typeof process !== 'undefined' && process.stdout?.write) process.stdout.write(`${line}\n`);
}

export function createEmfPublisher(options: EmfPublisherOptions): EmfPublisher {
  const flushIntervalMs = options.flushIntervalMs ?? 60_000;
  const maxSeries = options.maxSeries ?? 2_000;
  const write = options.write ?? defaultWrite;
  const now = options.now ?? Date.now;
  let series = new Map<string, Series>();

  const line = (entry: Series, timestamp: number): string => {
    const { metric } = entry;
    const dimensions = [
      ['Service'],
      ...(metric.dimensionSets ?? []).map((set) => ['Service', ...set]),
    ];
    let value: unknown;
    if (metric.kind === 'sum') value = entry.sum;
    else if (metric.kind === 'gauge') value = entry.last;
    else {
      const { values, counts } = boundedDistribution(entry.buckets);
      value = {
        Values: values,
        Counts: counts,
        Max: entry.max,
        Min: entry.min,
        Count: entry.count,
        Sum: entry.sum,
      };
    }
    return JSON.stringify({
      _aws: {
        Timestamp: timestamp,
        CloudWatchMetrics: [
          {
            Namespace: options.namespace,
            Dimensions: dimensions,
            Metrics: [{ Name: metric.name, Unit: metric.unit }],
          },
        ],
      },
      ...entry.labels,
      Service: options.service,
      [metric.name]: value,
    });
  };

  const flush = (): void => {
    if (series.size === 0) return;
    const current = series;
    series = new Map();
    const timestamp = now();
    for (const entry of current.values()) {
      try {
        write(line(entry, timestamp));
      } catch {
        // Metrics are best effort; a failed write must never reach a request.
      }
    }
  };

  const timer = setInterval(flush, flushIntervalMs);
  (timer as { unref?: () => void }).unref?.();

  return {
    record(metric, value, labels) {
      if (!Number.isFinite(value)) return;
      if (metric.kind !== 'gauge' && value < 0) return;
      let clean = cleanLabels(metric, labels);
      let key = seriesKey(metric, clean);
      if (!series.has(key) && series.size >= maxSeries) {
        clean = Object.fromEntries(Object.keys(clean).map((name) => [name, 'other']));
        key = seriesKey(metric, clean);
      }
      let entry = series.get(key);
      if (!entry) {
        entry = {
          metric,
          labels: clean,
          sum: 0,
          last: 0,
          count: 0,
          min: Number.POSITIVE_INFINITY,
          max: Number.NEGATIVE_INFINITY,
          buckets: new Map(),
        };
        series.set(key, entry);
      }
      entry.sum += value;
      entry.last = value;
      entry.count += 1;
      entry.min = Math.min(entry.min, value);
      entry.max = Math.max(entry.max, value);
      if (metric.kind === 'distribution') {
        const bucket = bucketOf(value);
        entry.buckets.set(bucket, (entry.buckets.get(bucket) ?? 0) + 1);
      }
    },
    flush,
    stop() {
      clearInterval(timer);
      flush();
    },
  };
}
