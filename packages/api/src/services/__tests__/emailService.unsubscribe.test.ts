/**
 * emailService unsubscribe SSRF coverage.
 *
 * The List-Unsubscribe HTTP fetch is routed through @oxyhq/core/server's
 * DNS-pinned `safeFetch`, replacing the prior hand-rolled DNS lookup +
 * `fetch(redirect:'manual')` that left a DNS-rebind TOCTOU window open.
 *
 * Covered:
 *   1. https-only — a non-https URL throws before safeFetch is called.
 *   2. An SSRF-blocked target (safeFetch throws SsrfRejection) is surfaced as a
 *      "Private network URLs are not allowed" error (caller falls through).
 *   3. A non-2xx response (incl. a 3xx, since redirects are disallowed) throws.
 *   4. A 2xx response resolves and the response body stream is destroyed.
 */

const mockSafeFetch = jest.fn();
class FakeSsrfRejection extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SsrfRejection';
  }
}
jest.mock('@oxyhq/core/server', () => ({
  __esModule: true,
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfRejection: FakeSsrfRejection,
}));

jest.mock('../assetServiceSingleton', () => ({ assetService: {} }));
jest.mock('../senderAvatar.service', () => ({ getAvatarPathsBatch: jest.fn() }));
jest.mock('../aiLabeling.service', () => ({ aiLabelingService: {} }));
jest.mock('../cardExtraction.service', () => ({ cardExtractionService: {} }));
jest.mock('../smtp.outbound', () => ({ __esModule: true, smtpOutbound: { send: jest.fn() }, default: {} }));
jest.mock('../../utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { emailService } from '../email.service';

interface UnsubscribeHarness {
  fetchUnsubscribeUrl(
    url: string,
    options: { method: 'GET' | 'POST'; headers?: Record<string, string> },
  ): Promise<void>;
}

const svc = emailService as unknown as UnsubscribeHarness;

function fakeResponse(status: number) {
  return {
    status,
    headers: {},
    finalUrl: 'https://list.example/final',
    response: { destroy: jest.fn() },
  };
}

describe('emailService.fetchUnsubscribeUrl — SSRF-safe routing', () => {
  beforeEach(() => {
    mockSafeFetch.mockReset();
  });

  it('rejects a non-https unsubscribe URL before calling safeFetch', async () => {
    await expect(svc.fetchUnsubscribeUrl('http://list.example/unsub', { method: 'GET' })).rejects.toThrow(
      /HTTPS/i,
    );
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it('surfaces an SSRF-blocked target as a private-network error', async () => {
    mockSafeFetch.mockRejectedValue(new FakeSsrfRejection('hostname resolves to blocked range'));

    await expect(
      svc.fetchUnsubscribeUrl('https://internal.example/unsub', { method: 'GET' }),
    ).rejects.toThrow(/Private network URLs are not allowed/i);

    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(mockSafeFetch).toHaveBeenCalledWith(
      'https://internal.example/unsub',
      expect.objectContaining({ method: 'GET', maxRedirects: 0 }),
    );
  });

  it('treats a redirect (3xx, since redirects are disallowed) as a failure', async () => {
    const res = fakeResponse(302);
    mockSafeFetch.mockResolvedValue(res);

    await expect(
      svc.fetchUnsubscribeUrl('https://list.example/unsub', { method: 'GET' }),
    ).rejects.toThrow(/status 302/i);
    expect(res.response.destroy).toHaveBeenCalledTimes(1);
  });

  it('resolves and destroys the response body on a 2xx', async () => {
    const res = fakeResponse(200);
    mockSafeFetch.mockResolvedValue(res);

    await expect(
      svc.fetchUnsubscribeUrl('https://list.example/unsub', {
        method: 'POST',
        headers: { 'List-Unsubscribe': 'One-Click-Unsubscribe' },
      }),
    ).resolves.toBeUndefined();

    expect(mockSafeFetch).toHaveBeenCalledWith(
      'https://list.example/unsub',
      expect.objectContaining({
        method: 'POST',
        maxRedirects: 0,
        headers: expect.objectContaining({ 'List-Unsubscribe': 'One-Click-Unsubscribe' }),
      }),
    );
    expect(res.response.destroy).toHaveBeenCalledTimes(1);
  });
});
