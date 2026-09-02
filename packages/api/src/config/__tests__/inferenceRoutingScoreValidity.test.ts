import {
  INFERENCE_ROUTING_SCORE_MIN_VALIDITY_VARIABLE,
  routingScoreMinimumValidityMs,
  routingScoreValidityThreshold,
} from '../inferenceRoutingScoreValidity';

const original = process.env[INFERENCE_ROUTING_SCORE_MIN_VALIDITY_VARIABLE];

afterEach(() => {
  if (original === undefined) {
    delete process.env[INFERENCE_ROUTING_SCORE_MIN_VALIDITY_VARIABLE];
  } else {
    process.env[INFERENCE_ROUTING_SCORE_MIN_VALIDITY_VARIABLE] = original;
  }
});

describe(INFERENCE_ROUTING_SCORE_MIN_VALIDITY_VARIABLE, () => {
  it.each([undefined, '0', '-1', '1.5', 'abc', String(Number.MAX_SAFE_INTEGER)])(
    'fails closed for %s',
    (value) => {
      if (value === undefined) {
        delete process.env[INFERENCE_ROUTING_SCORE_MIN_VALIDITY_VARIABLE];
      } else {
        process.env[INFERENCE_ROUTING_SCORE_MIN_VALIDITY_VARIABLE] = value;
      }
      expect(() => routingScoreMinimumValidityMs()).toThrow(
        INFERENCE_ROUTING_SCORE_MIN_VALIDITY_VARIABLE
      );
    }
  );

  it('returns the exact configured positive horizon', () => {
    process.env[INFERENCE_ROUTING_SCORE_MIN_VALIDITY_VARIABLE] = '7200';
    expect(routingScoreMinimumValidityMs()).toBe(7_200_000);
    expect(routingScoreValidityThreshold(new Date('2026-09-02T00:00:00.000Z')).toISOString()).toBe(
      '2026-09-02T02:00:00.000Z'
    );
  });

  it('rejects a Date-range overflow even when the duration itself is safe', () => {
    process.env[INFERENCE_ROUTING_SCORE_MIN_VALIDITY_VARIABLE] = '1';
    expect(() => routingScoreValidityThreshold(new Date(8_640_000_000_000_000))).toThrow(
      'invalid validity threshold'
    );
  });
});
