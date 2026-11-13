import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEmfPublisher, type MetricDefinition } from '../metrics';

// The cross-language contract: Kaana's Go `internal/emf` runs the same file.
// Numbers JSON cannot carry travel as the strings below.
const SENTINELS: Record<string, number> = {
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
  '-Infinity': Number.NEGATIVE_INFINITY,
};

interface GoldenCase {
  name: string;
  definition: MetricDefinition;
  service: string;
  namespace: string;
  now: number;
  maxSeries?: number;
  observations: { labels: Record<string, string>; value: number | string }[];
  expectedLines: unknown[];
}

const cases: GoldenCase[] = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'fixtures', 'emf-golden.json'), 'utf8'),
);

describe('EMF golden fixture', () => {
  it('is not empty and has unique case names', () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map((entry) => entry.name)).size).toBe(cases.length);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const lines: string[] = [];
    const publisher = createEmfPublisher({
      namespace: entry.namespace,
      service: entry.service,
      write: (line) => lines.push(line),
      now: () => entry.now,
      ...(entry.maxSeries === undefined ? {} : { maxSeries: entry.maxSeries }),
    });
    for (const { labels, value } of entry.observations) {
      publisher.record(
        entry.definition,
        typeof value === 'string' ? SENTINELS[value] : value,
        labels,
      );
    }
    publisher.stop();
    expect(lines.map((line) => JSON.parse(line))).toEqual(entry.expectedLines);
  });
});
