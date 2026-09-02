import {
  assessInferenceRoutingReadiness,
  type InferenceRoutingReadinessRow,
} from '../inferenceRoutingReadiness.service';

const now = new Date('2026-09-02T00:00:00.000Z');
const minimumValidUntil = new Date('2026-09-02T02:00:00.000Z');

function completeRow(overrides: Partial<InferenceRoutingReadinessRow> = {}) {
  return {
    deploymentId: 'dep_ready',
    currentPriceVersionId: 'price_current',
    scorePriceVersionId: 'price_current',
    price: 100,
    latency: 100,
    latencyMeasurementWindowEnd: new Date('2026-09-01T23:00:00.000Z'),
    latencyValidUntil: new Date('2026-09-03T00:00:00.000Z'),
    throughput: 100,
    throughputMeasurementWindowEnd: new Date('2026-09-01T23:00:00.000Z'),
    throughputValidUntil: new Date('2026-09-03T00:00:00.000Z'),
    balanced: 100,
    balancedValidUntil: new Date('2026-09-03T00:00:00.000Z'),
    ...overrides,
  } satisfies InferenceRoutingReadinessRow;
}

describe('inference routing readiness decision', () => {
  it('refuses an empty census and accepts one complete current row', () => {
    expect(assessInferenceRoutingReadiness([], now, minimumValidUntil)).toEqual({
      status: 'empty',
    });
    expect(
      assessInferenceRoutingReadiness([completeRow()], now, minimumValidUntil)
    ).toEqual({ status: 'ready' });
  });

  it('refuses duplicate exact identities before considering evidence', () => {
    expect(
      assessInferenceRoutingReadiness(
        [completeRow(), completeRow({ balanced: null })],
        now,
        minimumValidUntil
      )
    ).toEqual({ status: 'collision', collisions: [['dep_ready', 2]] });
  });

  it.each([
    ['an unmapped row', { deploymentId: null }],
    ['a null score', { balanced: null }],
    ['a stale price version', { scorePriceVersionId: 'price_old' }],
    [
      'expired latency evidence',
      { latencyValidUntil: new Date('2026-09-02T01:59:59.999Z') },
    ],
    [
      'expired throughput evidence',
      { throughputValidUntil: new Date('2026-09-02T01:59:59.999Z') },
    ],
    [
      'expired balanced evidence',
      { balancedValidUntil: new Date('2026-09-02T01:59:59.999Z') },
    ],
    [
      'a future latency measurement',
      { latencyMeasurementWindowEnd: new Date('2026-09-02T00:00:00.001Z') },
    ],
    [
      'a future throughput measurement',
      { throughputMeasurementWindowEnd: new Date('2026-09-02T00:00:00.001Z') },
    ],
  ] as const)('refuses %s', (_label, overrides) => {
    expect(
      assessInferenceRoutingReadiness([completeRow(overrides)], now, minimumValidUntil)
    ).toMatchObject({ status: 'incomplete' });
  });
});
