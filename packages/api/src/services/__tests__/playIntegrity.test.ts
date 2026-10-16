/**
 * Play Integrity (ADR 0045): how Oxy judges a decoded verdict, and how it asks
 * Google to decode one — the JWT-bearer token mint and the decode call — with
 * Google replaced by a fake that checks what it is sent.
 */

import { createVerify, generateKeyPairSync } from 'node:crypto';
import {
  PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER_VARIABLE,
  PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY_VARIABLE,
  playIntegrityConfig,
  type PlayIntegrityConfig,
} from '../../config/playIntegrity';
import {
  createPlayIntegrityClient,
  judgePlayIntegrityVerdict,
  PlayIntegrityTokenRejectedError,
  PlayIntegrityUnavailableError,
  type PlayIntegrityVerdict,
} from '../playIntegrity.service';

const CERT = 'ab'.repeat(32);
const CERT_DIGEST = Buffer.from(CERT, 'hex').toString('base64url');
const NOW = new Date('2026-10-16T12:00:00.000Z');
const HASH = 'h'.repeat(43);

function verdict(overrides: { request?: object; app?: object } = {}): PlayIntegrityVerdict {
  return {
    requestDetails: {
      requestPackageName: 'earth.mention.app',
      requestHash: HASH,
      timestampMillis: String(NOW.getTime() + 1000),
      ...overrides.request,
    },
    appIntegrity: {
      appRecognitionVerdict: 'PLAY_RECOGNIZED',
      packageName: 'earth.mention.app',
      certificateSha256Digest: [CERT_DIGEST],
      ...overrides.app,
    },
  };
}

const expected = {
  packageName: 'earth.mention.app',
  signingCertSha256: [CERT],
  requestHash: HASH,
  notBefore: NOW,
  notAfter: new Date(NOW.getTime() + 120_000),
};

describe('judgePlayIntegrityVerdict', () => {
  it('accepts the registered package, certificate and challenge from a Play install', () => {
    expect(judgePlayIntegrityVerdict(verdict(), expected)).toBeNull();
  });

  it.each([
    ['package_mismatch', { app: { packageName: 'earth.mention.fake' } }],
    ['package_mismatch', { request: { requestPackageName: 'earth.mention.fake' } }],
    ['not_play_recognized', { app: { appRecognitionVerdict: 'UNRECOGNIZED_VERSION' } }],
    ['not_play_recognized', { app: { appRecognitionVerdict: 'UNEVALUATED' } }],
    [
      'certificate_not_registered',
      { app: { certificateSha256Digest: [Buffer.alloc(32, 9).toString('base64url')] } },
    ],
    ['certificate_not_registered', { app: { certificateSha256Digest: [] } }],
    ['request_hash_mismatch', { request: { requestHash: 'x'.repeat(43) } }],
    ['stale', { request: { timestampMillis: String(NOW.getTime() - 3_600_000) } }],
    ['stale', { request: { timestampMillis: 'soon' } }],
  ])('refuses with %s', (failure, overrides) => {
    expect(judgePlayIntegrityVerdict(verdict(overrides), expected)).toBe(failure);
  });
});

describe('createPlayIntegrityClient', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const config: PlayIntegrityConfig = {
    cloudProjectNumber: '123456789012',
    clientEmail: 'play-integrity@oxy-test.iam.gserviceaccount.com',
    privateKeyId: 'key-1',
    privateKey,
    tokenUri: 'https://oauth2.googleapis.com/token',
  };

  function google(decodeStatus = 200) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = jest.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url === config.tokenUri) {
        return new Response(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }), {
          status: 200,
        });
      }
      return new Response(
        decodeStatus === 200 ? JSON.stringify({ tokenPayloadExternal: verdict() }) : '{}',
        { status: decodeStatus },
      );
    });
    return { calls, fetch };
  }

  it('mints a service-account token once and decodes for the package', async () => {
    const { calls, fetch } = google();
    const client = createPlayIntegrityClient(config, { fetch, now: () => NOW.getTime() });
    await expect(client.decode('earth.mention.app', 'integrity-token')).resolves.toEqual(verdict());
    await client.decode('earth.mention.app', 'integrity-token-2');
    expect(calls.filter((call) => call.url === config.tokenUri)).toHaveLength(1);

    const grant = new URLSearchParams(calls[0]?.init.body as string);
    expect(grant.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, claims, signature] = (grant.get('assertion') as string).split('.');
    expect(JSON.parse(Buffer.from(header as string, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
      kid: 'key-1',
    });
    expect(JSON.parse(Buffer.from(claims as string, 'base64url').toString())).toMatchObject({
      iss: config.clientEmail,
      scope: 'https://www.googleapis.com/auth/playintegrity',
      aud: config.tokenUri,
    });
    expect(
      createVerify('RSA-SHA256')
        .update(`${header}.${claims}`)
        .verify(publicKey, signature as string, 'base64url'),
    ).toBe(true);

    const decode = calls[1];
    expect(decode?.url).toBe(
      'https://playintegrity.googleapis.com/v1/earth.mention.app:decodeIntegrityToken',
    );
    expect((decode?.init.headers as Record<string, string>).authorization).toBe('Bearer ya29.test');
    expect(JSON.parse(decode?.init.body as string)).toEqual({ integrityToken: 'integrity-token' });
  });

  it('reads a 400 as a refused token and anything else as unavailable', async () => {
    await expect(
      createPlayIntegrityClient(config, { fetch: google(400).fetch }).decode('a.b', 't'),
    ).rejects.toBeInstanceOf(PlayIntegrityTokenRejectedError);
    await expect(
      createPlayIntegrityClient(config, { fetch: google(503).fetch }).decode('a.b', 't'),
    ).rejects.toBeInstanceOf(PlayIntegrityUnavailableError);
    await expect(
      createPlayIntegrityClient(config, {
        fetch: async () => {
          throw new TypeError('fetch failed');
        },
      }).decode('a.b', 't'),
    ).rejects.toBeInstanceOf(PlayIntegrityUnavailableError);
  });
});

describe('playIntegrityConfig', () => {
  const saved = {
    project: process.env[PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER_VARIABLE],
    key: process.env[PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY_VARIABLE],
  };
  afterEach(() => {
    for (const [name, value] of [
      [PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER_VARIABLE, saved.project],
      [PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY_VARIABLE, saved.key],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('is null unconfigured, and refuses half a configuration', () => {
    delete process.env[PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER_VARIABLE];
    delete process.env[PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY_VARIABLE];
    expect(playIntegrityConfig()).toBeNull();
    process.env[PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER_VARIABLE] = '123';
    expect(() => playIntegrityConfig()).toThrow(PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY_VARIABLE);
  });

  it('reads a service-account key, raw or base64', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = JSON.stringify({
      type: 'service_account',
      client_email: 'sa@p.iam.gserviceaccount.com',
      private_key_id: 'k1',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    });
    process.env[PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER_VARIABLE] = '123';
    process.env[PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY_VARIABLE] = key;
    expect(playIntegrityConfig()).toMatchObject({
      cloudProjectNumber: '123',
      clientEmail: 'sa@p.iam.gserviceaccount.com',
      tokenUri: 'https://oauth2.googleapis.com/token',
    });
    process.env[PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY_VARIABLE] = Buffer.from(key).toString('base64');
    expect(playIntegrityConfig()?.privateKeyId).toBe('k1');
    process.env[PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY_VARIABLE] = '{"type":"authorized_user"}';
    expect(() => playIntegrityConfig()).toThrow('service-account key');
  });
});
