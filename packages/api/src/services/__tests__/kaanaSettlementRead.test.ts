/**
 * Oxy's reconciliation read of Kaana's settlement outbox, signed the way Kaana
 * verifies it (`internal/publicapi/settle.go`, `edgeauth.NewSettlementReadVerifier`):
 * Ed25519 over `oxy-kaana-settlement-read:v1\n<kid>\n<ms>\n<sha256 of the raw
 * query>`. The expected input is written out here rather than built with the
 * code under test, because the two sides once agreed with themselves and not
 * with each other: Oxy signed `oxy-kaana-settlements-read:v1` over `path?query`
 * and production refused every read with 401.
 */

jest.mock('../../utils/tracedFetch', () => ({ tracedFetch: jest.fn() }));

import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { tracedFetch } from '../../utils/tracedFetch';
import { HttpKaanaSettlementFeedReader } from '../kaanaSettlement.service';

const fetchMock = tracedFetch as jest.MockedFunction<typeof tracedFetch>;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const reader = new HttpKaanaSettlementFeedReader({
  baseUrl: 'https://kaana.ai',
  keyId: 'oxy-edge-2026-10',
  privateKey,
});

function kaanaVerifies(headers: Record<string, string>, rawQuery: string): boolean {
  const digest = createHash('sha256').update(rawQuery, 'utf8').digest('hex');
  const input = [
    'oxy-kaana-settlement-read:v1',
    headers['X-Oxy-Kaana-Key-Id'],
    headers['X-Oxy-Kaana-Timestamp'],
    digest,
  ].join('\n');
  const signature = Buffer.from(headers['X-Oxy-Kaana-Signature'].replace(/^v1=/, ''), 'base64');
  return verify(null, Buffer.from(input, 'utf8'), publicKey, signature);
}

describe('HttpKaanaSettlementFeedReader', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('{"data":[]}', { status: 200 }));
  });

  it.each([
    ['the first page', null, '', 'https://kaana.ai/internal/v1/settlements'],
    ['a later page', '42', 'cursor=42', 'https://kaana.ai/internal/v1/settlements?cursor=42'],
  ])('signs %s over the raw query Kaana verifies', async (_, cursor, rawQuery, url) => {
    await expect(reader.readPage(cursor)).resolves.toEqual({ data: [] });

    const [requested, init] = fetchMock.mock.calls[0];
    expect(requested).toBe(url);
    expect(kaanaVerifies(init?.headers as Record<string, string>, rawQuery)).toBe(true);
  });

  it('fails on anything but a 200, naming the status', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(reader.readPage(null)).rejects.toThrow('Kaana settlement feed answered 401');
  });
});
