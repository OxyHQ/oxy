/**
 * The file-event POST (ADR 0041 D9) is SSRF-safe: it goes through `safeFetch`
 * (DNS-pinned, public addresses only) with NO redirects and a bounded wait, as
 * the per-reference webhook it replaced did. Successor of
 * `assetService.notifyLinks.test.ts`, whose per-reference webhooks are gone.
 */
const mockSafeFetch = jest.fn();

jest.mock('@oxy.so/core/server', () => {
  const actual = jest.requireActual('@oxy.so/core/server');
  return { ...actual, safeFetch: (...args: unknown[]) => mockSafeFetch(...args) };
});
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { SsrfRejection } from '@oxy.so/core/server';
import { postFileEventWebhook, FILE_EVENT_TIMEOUT_MS } from '../fileEventDelivery.worker';

const request = {
  url: 'https://receiver.example/files',
  eventId: 'e1',
  eventType: 'file.deleted',
  body: '{"id":"e1"}',
  signature: 't=1,v1=ab',
};

describe('postFileEventWebhook', () => {
  beforeEach(() => mockSafeFetch.mockReset());

  it('POSTs the signed JSON through safeFetch, no redirects, bounded wait', async () => {
    const resume = jest.fn();
    mockSafeFetch.mockResolvedValueOnce({ status: 202, response: { resume } });
    await expect(postFileEventWebhook(request)).resolves.toBe(202);
    const [url, options] = mockSafeFetch.mock.calls[0];
    expect(url).toBe(request.url);
    expect(options).toMatchObject({
      method: 'POST',
      body: request.body,
      maxRedirects: 0,
      headersTimeoutMs: FILE_EVENT_TIMEOUT_MS,
      headers: {
        'content-type': 'application/json',
        'oxy-event-id': 'e1',
        'oxy-event-type': 'file.deleted',
        'oxy-signature': request.signature,
      },
    });
    expect(resume).toHaveBeenCalled();
  });

  it('lets an SSRF refusal reach the worker, which records it as a failed attempt', async () => {
    mockSafeFetch.mockRejectedValueOnce(new SsrfRejection('literal ip in blocked range'));
    await expect(postFileEventWebhook(request)).rejects.toBeInstanceOf(SsrfRejection);
  });
});
