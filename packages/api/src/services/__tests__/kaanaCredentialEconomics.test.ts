/**
 * Kaana credential economics → the funding class of a synced route.
 *
 * Pure derivation plus the signed read against a local fake Kaana. The wire
 * shape below is what Kaana's `kaana_read_provider_credential_economics()`
 * serves (migration 0018): a JSON-aggregated `capacityEvidence` array with
 * nulls stripped, Go nil slices as `null`.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, verify } from 'node:crypto';
import {
  CREDENTIAL_ECONOMICS_PATH,
  FUNDING_EVIDENCE_TTL_MS,
  HttpKaanaCredentialEconomicsReader,
  fundingEvidenceByProvider,
  fundingNeedsRenewal,
  parseCredentialEconomics,
} from '../kaanaCredentialEconomics.service';
import { providerTelemetrySigningInput } from '../kaanaProviderCostFeed.service';

const NOW = new Date('2026-10-11T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function key(
  provider: string,
  keyId: string,
  capacityCategory: string | null,
  capacityEvidence: unknown[] = [],
) {
  return {
    provider,
    keyId,
    keyClass: '',
    description:
      capacityCategory === null
        ? null
        : {
            revision: 3,
            capacityCategory,
            environment: 'production',
            commercialUse: 'unknown',
            fundingAccountId: 'kfa_0123456789abcdef0123456789abcdef',
            allowedModels: null,
            allowedCapabilities: null,
          },
    capacityEvidence,
  };
}

function derive(...credentials: ReturnType<typeof key>[]) {
  return fundingEvidenceByProvider(
    parseCredentialEconomics({ schemaVersion: 1, credentials, readAt: NOW.toISOString() }),
    NOW,
  );
}

describe('funding evidence from Kaana credential economics', () => {
  it('ranks a single promotional key as promotional credit for six hours', () => {
    const funding = derive(
      key('anthropic', '30033d0c-3ca8-48c4-be44-8538d81028dd', 'promotional'),
      key('openrouter', 'or-1', 'paid'),
    );
    expect(funding.get('anthropic')).toEqual({
      fundingClass: 'promotional_credit',
      fundingState: 'available',
      fundingEvidenceRef:
        'kaana-credential-economics:anthropic:30033d0c-3ca8-48c4-be44-8538d81028dd:description-revision-3',
      fundingObservedAt: NOW,
      fundingValidUntil: new Date(NOW.getTime() + FUNDING_EVIDENCE_TTL_MS),
    });
    // Paid is what the synced default already says.
    expect(funding.has('openrouter')).toBe(false);
  });

  it('leaves unknown what it cannot attribute or that nobody described', () => {
    expect(
      derive(key('anthropic', 'a', 'promotional'), key('anthropic', 'b', 'promotional')).size,
    ).toBe(0);
    expect(derive(key('anthropic', 'a', null)).size).toBe(0);
    for (const category of ['paid', 'prepaid', 'trial']) {
      expect(derive(key('anthropic', 'a', category)).size).toBe(0);
    }
  });

  it('reads spent, throttled and expired credit from fresh capacity evidence', () => {
    const observedAt = new Date(NOW.getTime() - HOUR).toISOString();
    const state = (...evidence: unknown[]) =>
      derive(key('anthropic', 'a', 'promotional', evidence)).get('anthropic')?.fundingState;
    expect(state({ kind: 'balance', observedAt, balanceCurrency: 'USD', balancePicos: '0' })).toBe(
      'exhausted',
    );
    expect(
      state({
        kind: 'balance',
        observedAt,
        balanceCurrency: 'USD',
        balancePicos: '120000000000000',
      }),
    ).toBe('available');
    expect(
      state({
        kind: 'quota',
        observedAt,
        quotaUnit: 'usd',
        quotaWindow: 'month',
        quotaRemaining: 0,
      }),
    ).toBe('exhausted');
    expect(
      state({
        kind: 'quota',
        observedAt,
        quotaUnit: 'requests',
        quotaWindow: 'minute',
        quotaRemaining: 0,
      }),
    ).toBe('rate_limited');
    expect(
      state({ kind: 'expiry', observedAt, expiresAt: new Date(NOW.getTime() - 1).toISOString() }),
    ).toBe('exhausted');
    // Evidence whose freshness window has passed says nothing any more.
    expect(
      state({
        kind: 'balance',
        observedAt,
        freshUntil: new Date(NOW.getTime() - 1).toISOString(),
        balancePicos: '0',
      }),
    ).toBe('available');
  });

  it('never lets the window outlive a stated expiry', () => {
    const expiresAt = new Date(NOW.getTime() + 2 * HOUR);
    const funding = derive(
      key('anthropic', 'a', 'promotional', [
        { kind: 'expiry', observedAt: NOW.toISOString(), expiresAt: expiresAt.toISOString() },
      ]),
    ).get('anthropic');
    expect(funding?.fundingValidUntil).toEqual(expiresAt);
    expect(funding?.fundingState).toBe('available');
  });

  it('renews a window once less than half of it is left', () => {
    expect(fundingNeedsRenewal(null, NOW)).toBe(true);
    expect(fundingNeedsRenewal(new Date(NOW.getTime() + 4 * HOUR), NOW)).toBe(false);
    expect(fundingNeedsRenewal(new Date(NOW.getTime() + 2 * HOUR), NOW)).toBe(true);
  });

  it('refuses a body that is not the credential economics read', () => {
    expect(() => parseCredentialEconomics({ schemaVersion: 2, credentials: [] })).toThrow();
    expect(() => parseCredentialEconomics({ schemaVersion: 1 })).toThrow();
  });
});

describe('HttpKaanaCredentialEconomicsReader', () => {
  it('reads the operator path signed under the provider-telemetry domain', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    let seen: { url?: string; headers: http.IncomingHttpHeaders; body: Buffer } | undefined;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen = { url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(
          JSON.stringify({
            schemaVersion: 1,
            credentials: [key('anthropic', 'a', 'promotional')],
            readAt: NOW.toISOString(),
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const reader = new HttpKaanaCredentialEconomicsReader({
        baseUrl: `http://127.0.0.1:${port}`,
        keyId: 'oxy-edge-1',
        privateKey,
      } as never);
      const response = await reader.read(AbortSignal.timeout(5_000));
      expect(response.credentials).toHaveLength(1);
      if (seen === undefined) throw new Error('no request reached the fake Kaana');
      expect(seen.url).toBe(CREDENTIAL_ECONOMICS_PATH);
      expect(JSON.parse(seen.body.toString('utf8'))).toEqual({ schemaVersion: 1 });
      const signature = Buffer.from(
        String(seen.headers['x-oxy-kaana-signature']).replace(/^v1=/, ''),
        'base64',
      );
      expect(
        verify(
          null,
          providerTelemetrySigningInput(
            'oxy-edge-1',
            Number(seen.headers['x-oxy-kaana-timestamp']),
            seen.body,
          ),
          publicKey,
          signature,
        ),
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
