/**
 * Manifest-service tests: the golden multipart fixture (part headers, UUID id,
 * verifiable signature) and the full decision matrix (manifest / noUpdate when
 * current==head / RTE precedence + loop guard / rollout 0-100-no-key / protocol-0
 * 204 / unknown channel).
 *
 * Nothing is mocked. The rows are real Postgres rows, so the ordinal that keeps
 * a signed manifest's asset list byte-stable and the primary key that makes a
 * rollback directive singular are the real constraints rather than a fixture's
 * shape; the signing service is real (a real keypair + certificate), so every
 * signature assertion is genuine.
 */

import crypto from 'crypto';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  generateKeyPair,
  generateSelfSignedCodeSigningCertificate,
  convertCertificateToCertificatePEM,
  convertKeyPairToPEM,
} from '@expo/code-signing-certificates';

import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { applications } from '../../../db/schema/applications';
import { appUpdateAssets } from '../../../db/schema/appUpdateAssets';
import { appUpdates } from '../../../db/schema/appUpdates';
import { updateAssets } from '../../../db/schema/updateAssets';
import { updateChannelRollbacks } from '../../../db/schema/updateChannelRollbacks';
import { updateChannels } from '../../../db/schema/updateChannels';
import { users } from '../../../db/schema/users';
import { buildManifestResponse, isInRollout, type ManifestRequest } from '../manifest.service';
import { resetSigningKeyCache } from '../signing.service';

// --- Real signing material ---
const keyPair = generateKeyPair();
const notBefore = new Date();
const notAfter = new Date();
notAfter.setFullYear(notAfter.getFullYear() + 1);
const certificate = generateSelfSignedCodeSigningCertificate({
  keyPair,
  validityNotBefore: notBefore,
  validityNotAfter: notAfter,
  commonName: 'Oxy Updates Test',
});
const { privateKeyPEM } = convertKeyPairToPEM(keyPair);
const publicKey = new crypto.X509Certificate(
  convertCertificateToCertificatePEM(certificate)
).publicKey;

/** The instant every seeded update is created at, so manifests are comparable. */
const PUBLISHED_AT = new Date('2026-07-01T00:00:00.000Z');

interface ParsedPart {
  headers: Record<string, string>;
  body: string;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  process.env.UPDATES_CODE_SIGNING_PRIVATE_KEY = Buffer.from(privateKeyPEM, 'utf8').toString(
    'base64'
  );
  resetSigningKeyCache();
});

/** Split a multipart/mixed body into its parts (headers + raw body string). */
function parseMultipart(contentType: string, body: Buffer): ParsedPart[] {
  const boundaryMatch = contentType.match(/boundary=(.+)$/);
  if (!boundaryMatch) throw new Error(`no boundary in ${contentType}`);
  const boundary = boundaryMatch[1];
  const raw = body.toString('utf8');
  const segments = raw.split(`--${boundary}`).slice(1, -1);
  return segments.map((segment) => {
    const trimmed = segment.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const split = trimmed.indexOf('\r\n\r\n');
    const headerBlock = trimmed.slice(0, split);
    const partBody = trimmed.slice(split + 4);
    const headers: Record<string, string> = {};
    for (const line of headerBlock.split('\r\n')) {
      const colon = line.indexOf(':');
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    return { headers, body: partBody };
  });
}

function verifyPartSignature(part: ParsedPart): boolean {
  const header = part.headers['expo-signature'];
  const match = header?.match(/^sig="([^"]+)", keyid="([^"]+)"$/);
  if (!match) return false;
  return crypto
    .createVerify('RSA-SHA256')
    .update(Buffer.from(part.body, 'utf8'))
    .verify(publicKey, Buffer.from(match[1], 'base64'));
}

function partNamed(response: { headers: Record<string, string>; body?: Buffer }, name: string) {
  const parts = parseMultipart(response.headers['content-type'], response.body as Buffer);
  return parts.find((part) => part.headers['content-disposition']?.includes(`name="${name}"`));
}

/** A random lowercase-hex SHA-256, the shape every asset reference must match. */
function sha256Hex(): string {
  return `${randomUUID()}${randomUUID()}`.replace(/-/g, '').slice(0, 64);
}

async function uploadedAsset(): Promise<string> {
  const sha256 = sha256Hex();
  await getDb()
    .insert(updateAssets)
    .values({ sha256, contentType: 'image/png', size: 1, status: 'uploaded' });
  return sha256;
}

/** An application with one channel — the pair every request resolves against. */
async function track(): Promise<{ applicationId: string; channelId: string; channel: string }> {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({
    id: users.id,
  });
  const [application] = await getDb()
    .insert(applications)
    .values({ name: `OTA ${randomUUID()}`, ownerAccountId: owner.id })
    .returning({ id: applications.id });
  const channel = `production-${randomUUID().slice(0, 8)}`;
  const [row] = await getDb()
    .insert(updateChannels)
    .values({ applicationId: application.id, name: channel })
    .returning({ id: updateChannels.id });
  return { applicationId: application.id, channelId: row.id, channel };
}

interface SeedOptions {
  rolloutPercent?: number;
  createdAt?: Date;
  /** Asset keys, inserted at these positions in this order. */
  assetKeys?: string[];
}

/** A published update, its launch asset and its ordered manifest assets. */
async function publish(
  applicationId: string,
  channelId: string,
  options: SeedOptions = {}
): Promise<{ updateId: string; launchSha256: string; assetSha256s: string[] }> {
  const launchSha256 = await uploadedAsset();
  const [update] = await getDb()
    .insert(appUpdates)
    .values({
      applicationId,
      channelId,
      runtimeVersion: '1.0.0',
      platform: 'ios',
      status: 'published',
      launchAssetSha256: launchSha256,
      launchAssetKey: 'bundle-key',
      launchAssetContentType: 'application/javascript',
      // Clients ignore the launch asset's extension, and the manifest must omit
      // it even when one is stored.
      launchAssetFileExtension: '.js',
      extra: { expoClient: { name: 'demo', slug: 'demo' } },
      rolloutPercent: options.rolloutPercent ?? 100,
      createdAt: options.createdAt ?? PUBLISHED_AT,
    })
    .returning({ id: appUpdates.id, updateId: appUpdates.updateId });

  const keys = options.assetKeys ?? ['img-key'];
  const assetSha256s: string[] = [];
  while (assetSha256s.length < keys.length) {
    assetSha256s.push(await uploadedAsset());
  }
  await getDb().insert(appUpdateAssets).values(
    keys.map((key, ordinal) => ({
      appUpdateId: update.id,
      ordinal,
      sha256: assetSha256s[ordinal],
      key,
      contentType: 'image/png',
      fileExtension: '.png',
    }))
  );

  return { updateId: update.updateId, launchSha256, assetSha256s };
}

function baseRequest(
  applicationId: string,
  channel: string,
  overrides: Partial<ManifestRequest> = {}
): ManifestRequest {
  return {
    applicationId,
    platform: 'ios',
    runtimeVersion: '1.0.0',
    channelName: channel,
    protocolVersion: 1,
    expectSignature: true,
    ...overrides,
  };
}

describe('buildManifestResponse — golden manifest', () => {
  test('serves a signed multipart manifest with a UUID id and CDN asset urls', async () => {
    const { applicationId, channelId, channel } = await track();
    const seeded = await publish(applicationId, channelId);

    const response = await buildManifestResponse(baseRequest(applicationId, channel));

    expect(response.status).toBe(200);
    expect(response.headers['expo-protocol-version']).toBe('1');
    expect(response.headers['expo-sfv-version']).toBe('0');
    expect(response.headers['cache-control']).toBe('private, max-age=0');
    expect(response.headers['content-type']).toMatch(/^multipart\/mixed; boundary=/);

    const manifestPart = partNamed(response, 'manifest');
    const extensionsPart = partNamed(response, 'extensions');

    expect(manifestPart).toBeDefined();
    expect(extensionsPart).toBeDefined();
    expect(manifestPart?.headers['content-type']).toContain('application/json');
    // Manifest part is signed and the signature verifies over its exact bytes.
    expect(verifyPartSignature(manifestPart as ParsedPart)).toBe(true);

    const manifest = JSON.parse((manifestPart as ParsedPart).body);
    expect(manifest.id).toBe(seeded.updateId);
    expect(manifest.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(manifest.runtimeVersion).toBe('1.0.0');
    expect(manifest.createdAt).toBe('2026-07-01T00:00:00.000Z');
    expect(manifest.metadata).toEqual({});
    expect(manifest.extra).toEqual({ expoClient: { name: 'demo', slug: 'demo' } });

    // Launch asset omits fileExtension even though one is stored; url points at
    // cloud.oxy.so.
    expect(manifest.launchAsset.url).toBe(
      `https://cloud.oxy.so/updates/assets/${seeded.launchSha256}`
    );
    expect(manifest.launchAsset.fileExtension).toBeUndefined();
    expect(manifest.launchAsset.contentType).toBe('application/javascript');
    // Regular asset keeps fileExtension and carries a base64url hash.
    expect(manifest.assets[0].url).toBe(
      `https://cloud.oxy.so/updates/assets/${seeded.assetSha256s[0]}`
    );
    expect(manifest.assets[0].fileExtension).toBe('.png');
    expect(manifest.assets[0].hash).toBe(
      Buffer.from(seeded.assetSha256s[0], 'hex')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    );

    // Extensions part is present and unsigned.
    expect(JSON.parse((extensionsPart as ParsedPart).body)).toEqual({ assetRequestHeaders: {} });
    expect(extensionsPart?.headers['expo-signature']).toBeUndefined();
  });

  test('serves the asset list in its PUBLISHED order, not the order rows come back in', async () => {
    const { applicationId, channelId, channel } = await track();
    const seeded = await publish(applicationId, channelId, {
      assetKeys: ['first', 'second', 'third'],
    });

    const response = await buildManifestResponse(baseRequest(applicationId, channel));
    const manifest = JSON.parse((partNamed(response, 'manifest') as ParsedPart).body);

    // The manifest is signed and a device may fetch this update at any point in
    // the future, so these bytes must be identical forever — which is exactly
    // what `app_update_assets.ordinal` exists to guarantee.
    expect(manifest.assets.map((asset: { key: string }) => asset.key)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(manifest.assets.map((asset: { url: string }) => asset.url)).toEqual(
      seeded.assetSha256s.map((sha) => `https://cloud.oxy.so/updates/assets/${sha}`)
    );
  });

  test('omits signatures when the client did not request one', async () => {
    const { applicationId, channelId, channel } = await track();
    await publish(applicationId, channelId);

    const response = await buildManifestResponse(
      baseRequest(applicationId, channel, { expectSignature: false })
    );
    expect(partNamed(response, 'manifest')?.headers['expo-signature']).toBeUndefined();
  });
});

describe('buildManifestResponse — decision matrix', () => {
  test('current == head → noUpdateAvailable directive (signed)', async () => {
    const { applicationId, channelId, channel } = await track();
    const seeded = await publish(applicationId, channelId);

    const response = await buildManifestResponse(
      baseRequest(applicationId, channel, { currentUpdateId: seeded.updateId })
    );
    const directive = partNamed(response, 'directive');
    expect(directive).toBeDefined();
    expect(JSON.parse((directive as ParsedPart).body)).toEqual({ type: 'noUpdateAvailable' });
    expect(verifyPartSignature(directive as ParsedPart)).toBe(true);
  });

  test('an active rollback-to-embedded takes precedence over a servable head', async () => {
    const { applicationId, channelId, channel } = await track();
    // A head IS available: the directive must win anyway.
    await publish(applicationId, channelId);
    await getDb().insert(updateChannelRollbacks).values({
      channelId,
      runtimeVersion: '1.0.0',
      platform: 'ios',
      commitTime: new Date('2026-06-01T00:00:00.000Z'),
    });

    const response = await buildManifestResponse(baseRequest(applicationId, channel));
    const directive = partNamed(response, 'directive');
    expect(JSON.parse((directive as ParsedPart).body)).toEqual({
      type: 'rollBackToEmbedded',
      parameters: { commitTime: '2026-06-01T00:00:00.000Z' },
    });
    expect(verifyPartSignature(directive as ParsedPart)).toBe(true);
  });

  test('a directive for another runtime or platform does not apply', async () => {
    const { applicationId, channelId, channel } = await track();
    const seeded = await publish(applicationId, channelId);
    await getDb().insert(updateChannelRollbacks).values([
      { channelId, runtimeVersion: '2.0.0', platform: 'ios', commitTime: new Date() },
      { channelId, runtimeVersion: '1.0.0', platform: 'android', commitTime: new Date() },
    ]);

    const response = await buildManifestResponse(baseRequest(applicationId, channel));
    const manifest = JSON.parse((partNamed(response, 'manifest') as ParsedPart).body);
    expect(manifest.id).toBe(seeded.updateId);
  });

  test('rollback-to-embedded loop guard: client already on embedded → noUpdateAvailable', async () => {
    const { applicationId, channelId, channel } = await track();
    await getDb().insert(updateChannelRollbacks).values({
      channelId,
      runtimeVersion: '1.0.0',
      platform: 'ios',
      commitTime: new Date('2026-06-01T00:00:00.000Z'),
    });

    const response = await buildManifestResponse(
      baseRequest(applicationId, channel, {
        currentUpdateId: 'embedded-1',
        embeddedUpdateId: 'embedded-1',
      })
    );
    const directive = partNamed(response, 'directive');
    expect(JSON.parse((directive as ParsedPart).body)).toEqual({ type: 'noUpdateAvailable' });
  });

  test('unknown channel → noUpdateAvailable directive', async () => {
    const { applicationId } = await track();
    const response = await buildManifestResponse(baseRequest(applicationId, 'nope'));
    const directive = partNamed(response, 'directive');
    expect(JSON.parse((directive as ParsedPart).body)).toEqual({ type: 'noUpdateAvailable' });
  });

  test('no channel header at all → noUpdateAvailable directive', async () => {
    const { applicationId, channelId, channel } = await track();
    await publish(applicationId, channelId);
    const response = await buildManifestResponse(
      baseRequest(applicationId, channel, { channelName: undefined })
    );
    const directive = partNamed(response, 'directive');
    expect(JSON.parse((directive as ParsedPart).body)).toEqual({ type: 'noUpdateAvailable' });
  });

  test('no published update → noUpdateAvailable directive', async () => {
    const { applicationId, channel } = await track();
    const response = await buildManifestResponse(baseRequest(applicationId, channel));
    const directive = partNamed(response, 'directive');
    expect(JSON.parse((directive as ParsedPart).body)).toEqual({ type: 'noUpdateAvailable' });
  });

  test('a rolled-back head is not servable', async () => {
    const { applicationId, channelId, channel } = await track();
    const seeded = await publish(applicationId, channelId);
    await getDb()
      .update(appUpdates)
      .set({ status: 'rolled_back' })
      .where(eq(appUpdates.updateId, seeded.updateId));

    const response = await buildManifestResponse(baseRequest(applicationId, channel));
    const directive = partNamed(response, 'directive');
    expect(JSON.parse((directive as ParsedPart).body)).toEqual({ type: 'noUpdateAvailable' });
  });

  test('partial-rollout head the device is OUT of → falls back to the previous full-rollout update', async () => {
    const { applicationId, channelId, channel } = await track();
    const previous = await publish(applicationId, channelId, {
      rolloutPercent: 100,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    await publish(applicationId, channelId, {
      rolloutPercent: 0, // 0% → nobody is in
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    });

    const response = await buildManifestResponse(
      baseRequest(applicationId, channel, { deviceKey: 'device-xyz' })
    );
    const manifest = JSON.parse((partNamed(response, 'manifest') as ParsedPart).body);
    expect(manifest.id).toBe(previous.updateId);
  });

  test('protocol 0 directive decision → 204 No Content', async () => {
    const { applicationId, channelId, channel } = await track();
    const seeded = await publish(applicationId, channelId);
    const response = await buildManifestResponse(
      baseRequest(applicationId, channel, {
        protocolVersion: 0,
        currentUpdateId: seeded.updateId,
      })
    );
    expect(response.status).toBe(204);
    expect(response.body).toBeUndefined();
  });

  test('protocol 0 still serves a real manifest normally', async () => {
    const { applicationId, channelId, channel } = await track();
    await publish(applicationId, channelId);
    const response = await buildManifestResponse(
      baseRequest(applicationId, channel, { protocolVersion: 0 })
    );
    expect(response.status).toBe(200);
    expect(partNamed(response, 'manifest')).toBeDefined();
  });

  test('requesting a signature with no key configured → surfaces CodeSigningNotConfiguredError', async () => {
    const { applicationId, channelId, channel } = await track();
    await publish(applicationId, channelId);
    delete process.env.UPDATES_CODE_SIGNING_PRIVATE_KEY;
    resetSigningKeyCache();

    await expect(
      buildManifestResponse(baseRequest(applicationId, channel, { expectSignature: true }))
    ).rejects.toThrow(/not configured/i);
  });
});

describe('isInRollout', () => {
  test('100% is always in; 0% is never in', () => {
    expect(isInRollout('u1', 100, undefined)).toBe(true);
    expect(isInRollout('u1', 100, 'dev')).toBe(true);
    expect(isInRollout('u1', 0, 'dev')).toBe(false);
  });

  test('a partial rollout with no device key is out', () => {
    expect(isInRollout('u1', 50, undefined)).toBe(false);
  });

  test('bucketing is deterministic per (update, device)', () => {
    const a = isInRollout('update-1', 50, 'device-1');
    const b = isInRollout('update-1', 50, 'device-1');
    expect(a).toBe(b);
  });
});
