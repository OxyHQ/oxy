import { translate } from '@oxy.so/core';
import { describeApiError } from '../../src/ui/utils/apiErrorMessage';

const t = (key: string, vars?: Record<string, string | number>) => translate('en-US', key, vars);
const failure = (fields: Record<string, unknown>) =>
  Object.assign(new Error('English for developers'), fields);

describe('describeApiError', () => {
  it('never shows the server message', () => {
    expect(describeApiError(failure({ code: 'SOMETHING_NEW', status: 409 }), t)).toBe(
      'Something went wrong. Please try again.',
    );
  });

  it('names what the caller was doing when nothing more specific is known', () => {
    expect(
      describeApiError(failure({ code: 'SOMETHING_NEW', status: 409 }), t, 'Could not save'),
    ).toBe('Could not save');
  });

  it('says a validation failure is about what was entered', () => {
    expect(describeApiError(failure({ code: 'BAD_REQUEST', status: 400 }), t, 'x')).toBe(
      "Something you entered isn't valid. Check it and try again.",
    );
  });

  it('tells an offline person to check the connection', () => {
    for (const code of ['NETWORK_ERROR', 'CONNECTION_FAILED', 'TIMEOUT']) {
      expect(describeApiError(failure({ code, status: 0 }), t)).toBe(
        "Couldn't reach Oxy. Check your connection and try again.",
      );
    }
    expect(describeApiError(failure({ status: 0 }), t)).toBe(
      "Couldn't reach Oxy. Check your connection and try again.",
    );
  });

  it('owns a server failure as ours', () => {
    expect(describeApiError(failure({ code: 'INTERNAL_ERROR', status: 500 }), t)).toBe(
      "Oxy couldn't finish this right now. Try again in a moment.",
    );
  });

  it('keeps the rate-limit wait', () => {
    expect(describeApiError(failure({ status: 429, details: { retryAfterSeconds: 12 } }), t)).toBe(
      'Too many attempts. Try again in 12s.',
    );
  });
});
