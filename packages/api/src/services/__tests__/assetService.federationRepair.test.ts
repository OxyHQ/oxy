/**
 * A federated asset whose stored original went missing is repaired from its
 * `metadata.remoteUrl` — but a URL names a location, not content. The record's
 * `sha256`, its content-addressed storage key, dedup and `by-sha256` lookups all
 * name the ORIGINAL bytes, so a repair may store only bytes that hash to
 * `files.sha256`. A remote that now serves a different (still valid) image must
 * be refused before anything is written under the old identity (#1285).
 *
 * The rows are real Postgres rows and the downloader is the real
 * `fetchFederationRepairImage` (MIME check, byte cap, streamed body read); only
 * `safeFetch` is faked, because it deliberately refuses loopback, so a local
 * HTTP fixture server cannot be reached through it. S3 and the variant queue are
 * faked so the test can see exactly what was written and enqueued.
 *
 * Mutation-tested: moving the digest comparison after `uploadBuffer` fails
 * "refuses different bytes before any write" on the upload assertion.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema';
import type { FileRecord } from '../../types/file.types';
import fileCache from '../../utils/fileCache';
import { findFileById, updateFile } from '../fileRepository';
import type { S3Service } from '../s3Service';

const mockSafeFetch = jest.fn();
const mockEnqueueVariants = jest.fn();

jest.mock('@oxy.so/core/server', () => ({
  ...jest.requireActual('@oxy.so/core/server'),
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
}));

jest.mock('../../queue/assetVariants.queue', () => ({
  enqueueAssetVariantGeneration: (...args: unknown[]) => mockEnqueueVariants(...args),
}));

jest.mock('../variantService', () => ({
  VariantService: class {
    generateVariants = jest.fn(() => Promise.resolve());
  },
}));

jest.mock('../s3ServiceSingleton', () => ({ s3Service: {} }));

import { AssetService, clearFederationRepairMismatches } from '../assetService';

const REMOTE_URL = 'https://remote.example/media/avatar.png?token=secret';

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** A real, decodable 1×1 PNG; distinct colours give distinct bytes and digests. */
async function pngOf(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({ create: { width: 1, height: 1, channels: 3, background: { r, g, b } } })
    .png()
    .toBuffer();
}

/** A random colour, so no two cases collide on the live-sha256 constraint. */
const randomPng = () => {
  const [r, g, b] = randomBytes(3);
  return pngOf(r, g, b);
};

function fetchResult(body: Buffer, headers: Record<string, string> = { 'content-type': 'image/png' }) {
  const response = Readable.from([body]) as IncomingMessage;
  response.statusCode = 200;
  response.headers = headers;
  return { response, status: 200, headers, finalUrl: REMOTE_URL };
}

function buildFakeS3() {
  return {
    fileExists: jest.fn(() => Promise.resolve(true)),
    uploadBuffer: jest.fn((_key: string, _buf: Buffer, _opts?: unknown) => Promise.resolve()),
    getPresignedUploadUrl: jest.fn(() => Promise.resolve('https://s3.invalid/put')),
  };
}

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

/**
 * Ingest `original` exactly as federation does (raw remote bytes through
 * `uploadFileDirect`), then make its stored object go missing.
 */
async function seedFederatedAvatar(original: Buffer, remoteUrl = REMOTE_URL) {
  const s3 = buildFakeS3();
  const service = new AssetService(s3 as unknown as S3Service);
  const file = await service.uploadFileDirect(
    await insertUser(),
    original,
    'image/png',
    'federated-avatar.png',
    'public',
    { source: 'federation', role: 'avatar', remoteUrl },
  );
  expect(file.sha256).toBe(sha256(original));

  s3.fileExists.mockImplementation(() => Promise.resolve(false));
  s3.uploadBuffer.mockClear();
  mockEnqueueVariants.mockClear();
  mockSafeFetch.mockReset();
  return { s3, service, file };
}

const identityOf = (file: FileRecord | null) =>
  file && {
    id: file.id,
    sha256: file.sha256,
    storageKey: file.storageKey,
    ownerUserId: file.ownerUserId,
    size: file.size,
    mime: file.mime,
    status: file.status,
  };

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  clearFederationRepairMismatches();
  mockSafeFetch.mockReset();
  mockEnqueueVariants.mockReset();
});

afterEach(() => {
  fileCache.clear();
});

afterAll(async () => {
  await closePostgres();
});

describe('repairMissingFederationFileContent verifies the original digest', () => {
  it('repairs from the same bytes: stored digest equals files.sha256 and variants are queued', async () => {
    const original = await randomPng();
    const { s3, service, file } = await seedFederatedAvatar(original);
    mockSafeFetch.mockResolvedValue(fetchResult(original));

    await expect(service.repairMissingFederationFileContent(file)).resolves.toBe(true);

    expect(s3.uploadBuffer).toHaveBeenCalledTimes(1);
    const [key, uploaded] = s3.uploadBuffer.mock.calls[0];
    expect(key).toBe(file.storageKey);
    expect(sha256(uploaded)).toBe(file.sha256);
    expect(mockEnqueueVariants).toHaveBeenCalledWith(file.id);
  });

  it('refuses different bytes before any write, and leaves the record untouched', async () => {
    const original = await randomPng();
    const replacement = await randomPng();
    expect(sha256(replacement)).not.toBe(sha256(original));
    const { s3, service, file } = await seedFederatedAvatar(original);
    const before = identityOf(await findFileById(file.id));
    mockSafeFetch.mockResolvedValue(fetchResult(replacement));

    await expect(service.repairMissingFederationFileContent(file)).resolves.toBe(false);

    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(s3.uploadBuffer).not.toHaveBeenCalled();
    expect(mockEnqueueVariants).not.toHaveBeenCalled();
    expect(identityOf(await findFileById(file.id))).toEqual(before);
    expect(identityOf(file)).toEqual(before);
  });

  it('does not download a known-mismatching source again on the next read', async () => {
    const original = await randomPng();
    const { s3, service, file } = await seedFederatedAvatar(original);
    mockSafeFetch.mockImplementation(async () => fetchResult(await randomPng()));

    await expect(service.repairMissingFederationFileContent(file)).resolves.toBe(false);
    await expect(service.repairMissingFederationFileContent(file)).resolves.toBe(false);

    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(s3.uploadBuffer).not.toHaveBeenCalled();
  });

  it('repairs once the remembered mismatch is cleared and the remote serves the original again', async () => {
    const original = await randomPng();
    const { s3, service, file } = await seedFederatedAvatar(original);
    mockSafeFetch.mockResolvedValueOnce(fetchResult(await randomPng()));
    await expect(service.repairMissingFederationFileContent(file)).resolves.toBe(false);

    clearFederationRepairMismatches();
    mockSafeFetch.mockResolvedValueOnce(fetchResult(original));
    await expect(service.repairMissingFederationFileContent(file)).resolves.toBe(true);
    expect(s3.uploadBuffer).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the stored object already exists', async () => {
    const { s3, service, file } = await seedFederatedAvatar(await randomPng());
    s3.fileExists.mockImplementation(() => Promise.resolve(true));

    await expect(service.repairMissingFederationFileContent(file)).resolves.toBe(true);
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(s3.uploadBuffer).not.toHaveBeenCalled();
  });

  it('does not repair a deleted record', async () => {
    const original = await randomPng();
    const { s3, service, file } = await seedFederatedAvatar(original);
    const deleted = await updateFile(file.id, { status: 'deleted' });
    mockSafeFetch.mockResolvedValue(fetchResult(original));

    await expect(service.repairMissingFederationFileContent(deleted as FileRecord)).resolves.toBe(false);
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(s3.uploadBuffer).not.toHaveBeenCalled();
  });

  it('still rejects a non-https remote URL without fetching', async () => {
    const original = await randomPng();
    const { s3, service, file } = await seedFederatedAvatar(original, 'http://remote.example/a.png');

    await expect(service.repairMissingFederationFileContent(file)).resolves.toBe(false);
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(s3.uploadBuffer).not.toHaveBeenCalled();
  });

  it('still rejects non-image content', async () => {
    const original = await randomPng();
    const { s3, service, file } = await seedFederatedAvatar(original);
    mockSafeFetch.mockResolvedValue(fetchResult(original, { 'content-type': 'text/html' }));

    await expect(service.repairMissingFederationFileContent(file)).resolves.toBe(false);
    expect(s3.uploadBuffer).not.toHaveBeenCalled();
  });

  it('still rejects an oversized declared body', async () => {
    const original = await randomPng();
    const { s3, service, file } = await seedFederatedAvatar(original);
    mockSafeFetch.mockResolvedValue(
      fetchResult(original, { 'content-type': 'image/png', 'content-length': String(64 * 1024 * 1024) }),
    );

    await expect(service.repairMissingFederationFileContent(file)).resolves.toBe(false);
    expect(s3.uploadBuffer).not.toHaveBeenCalled();
  });
});
