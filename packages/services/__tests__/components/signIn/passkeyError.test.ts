import { translate } from '@oxy.so/core';
import { describePasskeyError, isRateLimited } from '../../../src/ui/components/signIn/passkeyError';

const t = (key: string, vars?: Record<string, string | number>) => translate('en-US', key, vars);

const domError = (name: string) => Object.assign(new Error('The operation either timed out or was not allowed.'), { name });

describe('describePasskeyError', () => {
  it('reports a dismissed prompt calmly, wherever it sits in the cause chain', () => {
    const wrapped = Object.assign(new Error('WebAuthnError'), { cause: domError('NotAllowedError') });
    expect(describePasskeyError(wrapped, t)).toBe("Passkey prompt dismissed. Try again when you're ready.");
    expect(describePasskeyError(domError('AbortError'), t)).toBe("Passkey prompt dismissed. Try again when you're ready.");
    expect(describePasskeyError(Object.assign(new Error('x'), { code: 'ERROR_CEREMONY_ABORTED' }), t)).toBe(
      "Passkey prompt dismissed. Try again when you're ready.",
    );
  });

  it("keeps any other failure's own message", () => {
    expect(describePasskeyError(new Error('No passkey for this account.'), t)).toBe('No passkey for this account.');
  });

  it('falls back to a generic line when there is nothing to say', () => {
    expect(describePasskeyError(new Error('  '), t)).toBe("Couldn't complete the passkey. Please try again.");
    expect(describePasskeyError('nope', t)).toBe("Couldn't complete the passkey. Please try again.");
  });
});

describe('isRateLimited', () => {
  it('reads a 429 off either error shape', () => {
    expect(isRateLimited({ status: 429 })).toBe(true);
    expect(isRateLimited({ response: { status: 429 } })).toBe(true);
    expect(isRateLimited({ status: 401 })).toBe(false);
    expect(isRateLimited(undefined)).toBe(false);
  });
});
