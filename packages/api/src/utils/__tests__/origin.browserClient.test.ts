import { isBrowserClient } from '../origin';

describe('isBrowserClient', () => {
  it('returns true when Origin is present', () => {
    expect(isBrowserClient({ origin: 'https://accounts.oxy.so' })).toBe(true);
  });

  it('returns true when Sec-Fetch-Site is present', () => {
    expect(isBrowserClient({ 'sec-fetch-site': 'same-origin' })).toBe(true);
  });

  it('returns false when neither browser signal is present', () => {
    expect(isBrowserClient({})).toBe(false);
  });

  it('returns false for non-browser custom headers only', () => {
    expect(isBrowserClient({ authorization: 'Bearer t' } as never)).toBe(false);
  });
});
