/**
 * `OxyServer.assets` — application-owned files (ADR 0041) and the user-media
 * upload helper.
 *
 * Stubs `serviceRequest`, the service-token transport, so these pin exactly
 * what each call sends: the route, the raw bytes as the body, and the headers
 * that carry visibility, owner and description. The OWNER of an application
 * file is never sent at all — the server takes it from the token — so no
 * header here may name one.
 */

import { OxyServer } from '../OxyServer';
import type { ApplicationFileUpload } from '../../models/interfaces';

const file = {
  id: 'file-1',
  sha256: 'a'.repeat(64),
  size: 4,
  mime: 'image/png',
  ext: '.png',
  ownerApplicationId: 'app-1',
  status: 'active' as const,
  visibility: 'public' as const,
  createdAt: '2026-10-16T00:00:00.000Z',
  updatedAt: '2026-10-16T00:00:00.000Z',
};

describe('OxyServer.assets — application-owned files', () => {
  let oxy: OxyServer;
  let serviceRequestSpy: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServer({ baseURL: 'http://test.invalid' });
    serviceRequestSpy = jest.spyOn(oxy, 'serviceRequest');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uploadAppFile POSTs the bytes with x-visibility and the description, naming no owner', async () => {
    const result: ApplicationFileUpload = { file, deduplicated: false };
    serviceRequestSpy.mockResolvedValueOnce(result);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    await expect(
      oxy.assets.uploadAppFile(bytes, 'image/png', {
        visibility: 'public',
        originalName: 'tile.png',
        metadata: { width: 512 },
      }),
    ).resolves.toEqual(result);

    expect(serviceRequestSpy).toHaveBeenCalledTimes(1);
    const [method, url, body, options] = serviceRequestSpy.mock.calls[0];
    expect([method, url, body]).toEqual(['POST', '/assets/service/app', bytes]);
    expect(options.headers).toEqual({
      'Content-Type': 'image/png',
      'x-visibility': 'public',
      'x-original-name': 'tile.png',
      'x-media-metadata': JSON.stringify({ width: 512 }),
    });
    expect(options.retry).toBe(false);
    expect(Object.keys(options.headers)).not.toContain('x-owner-user-id');
  });

  it('leaves out an original name a header cannot carry', async () => {
    serviceRequestSpy.mockResolvedValueOnce({ file, deduplicated: false });

    await oxy.assets.uploadAppFile(new Uint8Array([1]), 'image/png', {
      visibility: 'private',
      originalName: 'categoría.png',
    });

    expect(serviceRequestSpy.mock.calls[0][3].headers).toEqual({
      'Content-Type': 'image/png',
      'x-visibility': 'private',
    });
  });

  it('setAppFileVisibility PATCHes the visibility and returns the file', async () => {
    serviceRequestSpy.mockResolvedValueOnce({ file: { ...file, visibility: 'private' } });

    const updated = await oxy.assets.setAppFileVisibility('file/1', 'private');

    expect(updated.visibility).toBe('private');
    expect(serviceRequestSpy.mock.calls[0].slice(0, 3)).toEqual([
      'PATCH',
      '/assets/service/app/file%2F1/visibility',
      { visibility: 'private' },
    ]);
  });

  it('deleteAppFile DELETEs the file and lets a refusal propagate', async () => {
    serviceRequestSpy.mockResolvedValueOnce({ id: 'file-1', result: 'deleted' });
    await expect(oxy.assets.deleteAppFile('file-1')).resolves.toBeUndefined();
    expect(serviceRequestSpy.mock.calls[0].slice(0, 2)).toEqual([
      'DELETE',
      '/assets/service/app/file-1',
    ]);

    serviceRequestSpy.mockRejectedValueOnce(
      Object.assign(new Error('File not found'), { status: 404 }),
    );
    await expect(oxy.assets.deleteAppFile('someone-elses')).rejects.toThrow('File not found');
  });

  it('listAppFiles GETs one page, passing limit and cursor', async () => {
    serviceRequestSpy.mockResolvedValueOnce({ files: [file], nextCursor: 'next' });

    const page = await oxy.assets.listAppFiles({ limit: 10, cursor: 'abc' });

    expect(page).toEqual({ files: [file], nextCursor: 'next' });
    expect(serviceRequestSpy.mock.calls[0].slice(0, 2)).toEqual([
      'GET',
      '/assets/service/app?limit=10&cursor=abc',
    ]);

    serviceRequestSpy.mockResolvedValueOnce({ files: [] });
    await oxy.assets.listAppFiles();
    expect(serviceRequestSpy.mock.calls[1][1]).toBe('/assets/service/app');
  });
});

describe('OxyServer.assets.uploadUserMedia', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POSTs the bytes to /assets/service/user-media naming the owner in x-owner-user-id', async () => {
    const oxy = new OxyServer({ baseURL: 'http://test.invalid' });
    const spy = jest.spyOn(oxy, 'serviceRequest').mockResolvedValueOnce({
      file: { id: 'f', sha256: 'b'.repeat(64), size: 1, mime: 'image/jpeg', visibility: 'public' },
    });
    const bytes = new Uint8Array([0xff, 0xd8]);

    const stored = await oxy.assets.uploadUserMedia('user-1', bytes, 'image/jpeg', {
      originalName: 'photo.jpg',
    });

    expect(stored.id).toBe('f');
    const [method, url, body, options] = spy.mock.calls[0];
    expect([method, url, body]).toEqual(['POST', '/assets/service/user-media', bytes]);
    expect(options.headers).toEqual({
      'Content-Type': 'image/jpeg',
      'x-original-name': 'photo.jpg',
      'x-owner-user-id': 'user-1',
    });
  });
});
