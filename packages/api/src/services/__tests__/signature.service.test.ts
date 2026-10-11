import SignatureService, { MAX_CLOCK_SKEW_MS } from '../signature.service';

describe('SignatureService timestamp freshness', () => {
  const publicKey = '04' + 'a'.repeat(128);
  const signature = 'deadbeef';

  beforeEach(() => {
    jest.spyOn(SignatureService, 'verifySignature').mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects challenge responses with a timestamp too far in the future', () => {
    const future = Date.now() + MAX_CLOCK_SKEW_MS + 1_000;
    expect(
      SignatureService.verifyChallengeResponse(publicKey, 'challenge', signature, future),
    ).toBe(false);
  });

  it('accepts challenge responses within the clock-skew window', () => {
    const slightlyFuture = Date.now() + MAX_CLOCK_SKEW_MS - 1_000;
    expect(
      SignatureService.verifyChallengeResponse(publicKey, 'challenge', signature, slightlyFuture),
    ).toBe(true);
  });

  it('rejects registration signatures with a timestamp too far in the future', () => {
    const future = Date.now() + MAX_CLOCK_SKEW_MS + 1_000;
    expect(SignatureService.verifyRegistrationSignature(publicKey, signature, future)).toBe(false);
  });

  it('accepts registration signatures within the clock-skew window', () => {
    const slightlyFuture = Date.now() + MAX_CLOCK_SKEW_MS - 1_000;
    expect(SignatureService.verifyRegistrationSignature(publicKey, signature, slightlyFuture)).toBe(
      true,
    );
  });

  it('rejects request signatures with a timestamp too far in the future', () => {
    const future = Date.now() + MAX_CLOCK_SKEW_MS + 1_000;
    expect(
      SignatureService.verifyRequestSignature(publicKey, { action: 'test' }, signature, future),
    ).toBe(false);
  });

  it('accepts request signatures within the clock-skew window', () => {
    const slightlyFuture = Date.now() + MAX_CLOCK_SKEW_MS - 1_000;
    expect(
      SignatureService.verifyRequestSignature(
        publicKey,
        { action: 'test' },
        signature,
        slightlyFuture,
      ),
    ).toBe(true);
  });
});
