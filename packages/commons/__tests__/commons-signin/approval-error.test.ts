/**
 * The approval sheet's error state shows translated copy chosen by KIND. It used
 * to show `getCommonsApprovalBlockingReason`'s English sentence, or the thrown
 * error's raw message ("Request failed with status code 404").
 */
import {
  APPROVAL_ERROR_KEYS,
  approvalErrorKind,
  approvalInfoBlockingKind,
} from '@/lib/commons-signin/approval-error';
import en from '@/lib/i18n/locales/en.json';
import es from '@/lib/i18n/locales/es.json';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const PENDING = {
  application: { id: 'app-1' },
  status: 'pending',
  expiresAt: '2026-10-24T12:05:00Z',
} as never;

function lookup(dictionary: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => {
    return node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
  }, dictionary);
}

describe('approvalInfoBlockingKind', () => {
  it('lets a pending, unexpired request with an application through', () => {
    expect(approvalInfoBlockingKind(PENDING, NOW)).toBeNull();
  });

  it('names each reason a resolved request cannot be approved', () => {
    expect(
      approvalInfoBlockingKind({ ...(PENDING as object), application: null } as never, NOW),
    ).toBe('unresolvedApp');
    expect(
      approvalInfoBlockingKind({ ...(PENDING as object), status: 'approved' } as never, NOW),
    ).toBe('unavailable');
    expect(
      approvalInfoBlockingKind(
        { ...(PENDING as object), expiresAt: '2026-10-24T11:59:00Z' } as never,
        NOW,
      ),
    ).toBe('expired');
  });
});

describe('approvalErrorKind', () => {
  const http = (status: number) =>
    Object.assign(new Error(`Request failed with status code ${status}`), {
      status,
      code: 'HTTP',
    });

  it('a 4xx means the request is invalid, used or cancelled', () => {
    expect(approvalErrorKind(http(404))).toBe('unavailable');
    expect(approvalErrorKind(http(409))).toBe('unavailable');
  });

  it('rate limits and server errors are a retryable failure', () => {
    expect(approvalErrorKind(http(429))).toBe('failed');
    expect(approvalErrorKind(http(503))).toBe('failed');
    expect(approvalErrorKind(new Error('boom'))).toBe('failed');
  });

  it('a network failure says so', () => {
    expect(approvalErrorKind(new TypeError('Network request failed'))).toBe('network');
  });
});

describe('APPROVAL_ERROR_KEYS', () => {
  it.each(Object.entries(APPROVAL_ERROR_KEYS))('%s is translated in en and es', (_kind, key) => {
    expect(typeof lookup(en, key)).toBe('string');
    expect(typeof lookup(es, key)).toBe('string');
  });
});
