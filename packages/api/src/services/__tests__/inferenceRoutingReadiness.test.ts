import {
  assessInferenceRoutingReadiness,
  earliestInferenceRoutingEvidenceExpiry,
  type InferenceRoutingReadinessRow,
} from '../inferenceRoutingReadiness.service';

const now = new Date('2026-09-02T00:00:00.000Z');
const minimumValidUntil = new Date('2026-09-02T02:00:00.000Z');

function completeRow(overrides: Partial<InferenceRoutingReadinessRow> = {}) {
  return {
    deploymentId: 'dep_ready',
    currentPriceVersionId: 'price_current',
    requestUnitPriceVersionId: 'price_current',
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
    ['a missing request unit price', { requestUnitPriceVersionId: null }],
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

describe('earliest inference routing evidence expiry', () => {
  it('reports no expiry for an empty census', () => {
    expect(earliestInferenceRoutingEvidenceExpiry([])).toBeUndefined();
  });

  it('names the route and dimension instant that lapses first', () => {
    const cliff = new Date('2026-09-02T12:00:00.000Z');
    expect(
      earliestInferenceRoutingEvidenceExpiry([
        completeRow({ deploymentId: 'dep_later' }),
        completeRow({ deploymentId: 'dep_cliff', balancedValidUntil: cliff }),
        completeRow({ deploymentId: 'dep_unscored', latencyValidUntil: null }),
      ])
    ).toEqual({ deploymentId: 'dep_cliff', validUntil: cliff });
  });

  it('is what a seven-day early-warning horizon refuses before runtime does', () => {
    const warningNow = new Date('2026-09-25T00:00:00.000Z');
    const sevenDays = new Date(warningNow.getTime() + 7 * 24 * 60 * 60 * 1000);
    const cliff = completeRow({
      latencyMeasurementWindowEnd: new Date('2026-09-02T00:00:00.000Z'),
      throughputMeasurementWindowEnd: new Date('2026-09-02T00:00:00.000Z'),
      latencyValidUntil: new Date('2026-10-02T00:00:00.000Z'),
      throughputValidUntil: new Date('2026-10-02T00:00:00.000Z'),
      balancedValidUntil: new Date('2026-10-01T23:59:59.999Z'),
    });
    expect(assessInferenceRoutingReadiness([cliff], warningNow, sevenDays).status).toBe(
      'incomplete'
    );
    expect(
      assessInferenceRoutingReadiness(
        [cliff],
        warningNow,
        new Date(warningNow.getTime() + 3_600_000)
      )
    ).toEqual({ status: 'ready' });
  });
});
