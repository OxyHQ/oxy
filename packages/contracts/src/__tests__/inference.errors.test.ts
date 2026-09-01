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

  it('can classify a platform-side failure no retry will ever clear', () => {
    // The closed set had no such code, and the gap was found from the other side
    // of the interface (OxyHQ/Relay#1, issue #1017): an upstream refusing the
    // PLATFORM's own credential could only be reported as `provider_error`,
    // which is retryable, so every client retried a request that cannot succeed
    // until an operator rotates a key.
    expect(INFERENCE_ERROR_CODES).toContain('provider_credential_invalid');
    expect(NON_RETRYABLE_INFERENCE_ERROR_CODES as readonly string[]).toContain(
      'provider_credential_invalid',
    );
    expect(
      inferenceErrorSchema.safeParse({
        ...error,
        code: 'provider_credential_invalid',
        retryable: true,
      }).success,
    ).toBe(false);

    // The customer-side half of the same failure stays its own code, so nobody
    // is told to fix a credential that is not theirs.
    expect(INFERENCE_ERROR_CODES).toContain('byok_credential_invalid');
  });

  it('separates an upstream refusing to bill OXY from a customer quota', () => {
    // The second gap the same port found (OxyHQ/Relay#3, issue #1027): an
    // upstream answering 402 to the PLATFORM could only be reported as
    // `quota_exceeded`, which is right about retryability and points the
    // customer at their own balance — an account that is not the one at fault
    // and that they cannot fix by funding.
    expect(INFERENCE_ERROR_CODES).toContain('provider_billing_refused');
    expect(NON_RETRYABLE_INFERENCE_ERROR_CODES as readonly string[]).toContain(
      'provider_billing_refused',
    );
    expect(
      inferenceErrorSchema.safeParse({
        ...error,
        code: 'provider_billing_refused',
        retryable: true,
      }).success,
    ).toBe(false);
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

  it('refuses text a span redaction has stripped the marker from (#1027)', () => {
    // The mechanism OxyHQ/Relay#3 measured. An upstream echoes a request header
    // back in its error body; a producer redacts the span its OWN copy of this
    // pattern matched, which is the MARKER, and the value survives. The
    // unredacted string was refused, so the redacted one being accepted means
    // redaction turned a refused string into an accepted one carrying the same
    // secret.
    const value = 'EXAMPLEKEYNOTREAL0000';
    const echoedHeader = `{x-api-key: ${value}}`;
    const spanRedacted = `{x-[redacted] ${value}}`;

    expect(safeErrorTextSchema.safeParse(echoedHeader).success).toBe(false);
    expect(safeErrorTextSchema.safeParse(spanRedacted).success).toBe(false);
  });

  it('recognises the credential header names an upstream actually echoes', () => {
    // The pattern this replaced matched `authorization` and `api_key` as
    // literals. Every spelling below is one a real provider puts in an error
    // body, and each has to be refused on its own — the fix is not "one more
    // marker", it is that the marker is now a FAMILY.
    for (const header of [
      'x-api-key',
      'anthropic-api-key',
      'x-goog-api-key',
      'proxy-authorization',
      'x-auth-token',
      'client_secret',
    ]) {
      const leaking = `unexpected header {"${header}": "EXAMPLEKEYNOTREAL0000"}`;
      expect(safeErrorTextSchema.safeParse(leaking).success).toBe(false);
    }
  });

  it('refuses an issued token shape with no marker in front of it', () => {
    // The layer that survives a producer stripping the marker. A closed list of
    // shapes providers ISSUE, not an entropy score — so it fires here and not
    // on the request ids in the benign case below.
    for (const leaking of [
      'upstream rejected sk-EXAMPLE-NOT-A-REAL-KEY-0000',
      'the credential eyJhbGciOiJub25lIn0.eyJzdWIiOiJleGFtcGxlIn0.EXAMPLE0 was refused',
      'AKIAEXAMPLENOTREAL00 is not authorized to invoke this model',
      // The header VALUE quoted without its name — an upstream reporting what
      // it could not parse, with nothing a name-based rule could key on.
      'could not parse Bearer EXAMPLETOKENNOTREAL0 as a header value',
    ]) {
      expect(safeErrorTextSchema.safeParse(leaking).success).toBe(false);
    }
  });

  it('accepts a message whose credential VALUE was replaced', () => {
    // Deliberate, and the other half of the #1027 fix: the previous pattern
    // refused every one of these, so the only redaction that satisfied it was
    // the one that removes the marker and keeps the secret. Accepting a correct
    // redaction is what removes the incentive to perform the dangerous one.
    for (const redacted of [
      'Authorization: [redacted]',
      'unexpected header {"x-api-key": "[REDACTED]"}',
      'api_key=*** is not valid',
      'authorization header <removed> did not authenticate',
    ]) {
      expect(safeErrorTextSchema.safeParse(redacted).success).toBe(true);
    }
  });

  it('keeps ordinary provider text, including ids and model names', () => {
    for (const benign of [
      'Rate limit reached for gpt-5 in organization org-x.',
      'Request req_01H8Z9T6NB exceeded the context window of 200000 tokens.',
      'The model anthropic/claude-opus-5@2026-05-01 is not available in eu-central-1.',
      // The words the credential markers are built from, in the places ordinary
      // error text puts them: none is followed by a value, so none fires.
      'This request needs 12.500000 USD and 3.250000 USD is available.',
      'No model anthropic/claude-opus-5 is available to you.',
      'The account that owns this application has no inference billing profile.',
    ]) {
      expect(safeErrorTextSchema.safeParse(benign).success).toBe(true);
    }
  });

  it('bounds the text rather than forwarding an arbitrary upstream body', () => {
    expect(safeErrorTextSchema.safeParse('x'.repeat(2001)).success).toBe(false);
    expect(safeErrorTextSchema.safeParse('').success).toBe(false);
  });
});
