import {
  INFERENCE_ERROR_CODES,
  NON_RETRYABLE_INFERENCE_ERROR_CODES,
  inferenceErrorSchema,
  providerErrorPassthroughSchema,
  safeErrorTextSchema,
  safeParseContract,
} from '../index';

const error = {
  schemaVersion: 1 as const,
  code: 'provider_overloaded' as const,
  message: 'The upstream provider is overloaded.',
  retryable: true,
  requestId: 'req_1',
  retryAfterMs: 1500,
};

describe('inferenceErrorSchema', () => {
  it('parses a retryable upstream error', () => {
    expect(safeParseContract(inferenceErrorSchema, error)).toEqual(error);
  });

  it('accepts every code in the closed set and nothing outside it', () => {
    for (const code of INFERENCE_ERROR_CODES) {
      const retryable = !(NON_RETRYABLE_INFERENCE_ERROR_CODES as readonly string[]).includes(code);
      expect(
        inferenceErrorSchema.safeParse({ ...error, code, retryable, retryAfterMs: undefined })
          .success,
      ).toBe(true);
    }

    for (const unknownCode of ['teapot', 'rate_limit', 'INVALID_REQUEST', '']) {
      expect(inferenceErrorSchema.safeParse({ ...error, code: unknownCode }).success).toBe(false);
    }
  });

  it('refuses to call a permanently failing code retryable', () => {
    for (const code of NON_RETRYABLE_INFERENCE_ERROR_CODES) {
      expect(
        inferenceErrorSchema.safeParse({ ...error, code, retryable: true }).success,
      ).toBe(false);
      expect(
        inferenceErrorSchema.safeParse({
          ...error,
          code,
          retryable: false,
          retryAfterMs: undefined,
        }).success,
      ).toBe(true);
    }
  });

  it('separates a rate limit from a quota', () => {
    // A rate limit clears within the window the response names; a quota is an
    // account ceiling only a human raises.
    expect(
      (NON_RETRYABLE_INFERENCE_ERROR_CODES as readonly string[]).includes('rate_limited'),
    ).toBe(false);
    expect(
      (NON_RETRYABLE_INFERENCE_ERROR_CODES as readonly string[]).includes('quota_exceeded'),
    ).toBe(true);
  });

  it('refuses a retry-after on an error that will never be retried', () => {
    expect(
      inferenceErrorSchema.safeParse({
        ...error,
        code: 'invalid_request',
        retryable: false,
        retryAfterMs: 1500,
      }).success,
    ).toBe(false);
  });

  it('always carries the request id a customer would report', () => {
    const { requestId, ...withoutRequestId } = error;
    expect(requestId).toBe('req_1');
    expect(inferenceErrorSchema.safeParse(withoutRequestId).success).toBe(false);
  });
});

describe('provider error passthrough', () => {
  it('carries the four fields a customer can act on', () => {
    expect(
      providerErrorPassthroughSchema.safeParse({
        provider: 'openai',
        status: 429,
        code: 'rate_limit_exceeded',
        message: 'Rate limit reached for gpt-5 in organization org-x.',
      }).success,
    ).toBe(true);
  });

  it('cannot be widened into carrying the request that caused it', () => {
    for (const extra of [
      { requestHeaders: { authorization: 'Bearer sk-live-4f9c2a7b1e6d' } },
      { body: '{"messages":[]}' },
      { curl: 'curl -H "Authorization: Bearer sk-live-4f9c2a7b1e6d" ...' },
      { raw: 'anything' },
    ]) {
      expect(
        providerErrorPassthroughSchema.safeParse({ provider: 'openai', ...extra }).success,
      ).toBe(false);
    }
  });

  it('refuses upstream text that echoes a credential', () => {
    for (const leaking of [
      'Incorrect API key provided: sk-live-4f9c2a7b1e6d8f3a5c0b',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc',
      'invalid header authorization = sk_live_4f9c2a7b1e6d',
      'api_key=4f9c2a7b1e6d8f3a5c0b is not valid',
    ]) {
      expect(safeErrorTextSchema.safeParse(leaking).success).toBe(false);
      expect(
        providerErrorPassthroughSchema.safeParse({ provider: 'openai', message: leaking }).success,
      ).toBe(false);
      // The same refusal applies to Oxy's own message: a leak is no less a leak
      // for having been written on this side of the boundary.
      expect(inferenceErrorSchema.safeParse({ ...error, message: leaking }).success).toBe(false);
    }
  });

  it('keeps ordinary provider text, including ids and model names', () => {
    for (const benign of [
      'Rate limit reached for gpt-5 in organization org-x.',
      'Request req_01H8Z9T6NB exceeded the context window of 200000 tokens.',
      'The model anthropic/claude-opus-5@2026-05-01 is not available in eu-central-1.',
    ]) {
      expect(safeErrorTextSchema.safeParse(benign).success).toBe(true);
    }
  });

  it('bounds the text rather than forwarding an arbitrary upstream body', () => {
    expect(safeErrorTextSchema.safeParse('x'.repeat(2001)).success).toBe(false);
    expect(safeErrorTextSchema.safeParse('').success).toBe(false);
  });
});
