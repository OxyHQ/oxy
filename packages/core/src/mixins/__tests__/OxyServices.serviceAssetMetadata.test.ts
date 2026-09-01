/**
 * `getServiceAssetMetadataByIds` mixin tests.
 *
 * Stubs `makeServiceRequest` (the service-token transport used by the route's
 * `serviceAuthMiddleware` + `files:read` scope) so the tests run with no network
 * and no `getServiceToken()` round-trip, then asserts:
 *  - empty / whitespace-only input no-ops to `[]` with no network call;
 *  - input is de-duplicated and a single chunk is sent for <= 100 unique ids,
 *    POSTed to `/assets/service/by-ids` as `{ ids }`;
 *  - the `{ data }` envelope is unwrapped to a bare `ServiceAssetMetadata[]`
 *    (mirroring how `makeServiceRequest<T[]>` returns the inner array);
 *  - inputs > 100 ids are chunked at 100/request and merged;
 *  - a failed chunk THROWS `ServiceAssetMetadataError` naming its ids, so a
 *    throttled request can never be read as "those assets do not exist";
 *  - `{ partial: true }` opts back into best-effort explicitly.
 */

import type { ServiceAssetMetadata } from '../../models/interfaces';
import { OxyServices } from '../../OxyServices';
import { ServiceAssetMetadataError } from '../../OxyServices.errors';

const sampleEntry: ServiceAssetMetadata = {
  id: 'asset-1',
  sha256: 'a'.repeat(64),
  mime: 'image/jpeg',
  size: 12345,
  status: 'active',
};

describe('OxyServices.assets — getServiceAssetMetadataByIds', () => {
  let oxy: OxyServices;
  let makeServiceRequestSpy: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    makeServiceRequestSpy = jest.spyOn(oxy, 'makeServiceRequest');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns [] and performs no network call for empty / whitespace input', async () => {
    await expect(oxy.getServiceAssetMetadataByIds([])).resolves.toEqual([]);
    await expect(oxy.getServiceAssetMetadataByIds(['', '   '])).resolves.toEqual([]);
    expect(makeServiceRequestSpy).not.toHaveBeenCalled();
  });

  it('de-duplicates and sends a single chunk for <= 100 unique ids', async () => {
    // makeServiceRequest unwraps the API's `{ data }` envelope, so the resolved
    // value is the bare array (NOT `{ data: [...] }`) — mirror that real shape.
    makeServiceRequestSpy.mockResolvedValueOnce([sampleEntry]);

    const result = await oxy.getServiceAssetMetadataByIds([
      'asset-1',
      'asset-1', // duplicate
      '   ', // dropped
    ]);

    expect(result).toEqual([sampleEntry]);
    expect(makeServiceRequestSpy).toHaveBeenCalledTimes(1);
    expect(makeServiceRequestSpy).toHaveBeenCalledWith(
      'POST',
      '/assets/service/by-ids',
      { ids: ['asset-1'] },
    );
  });

  it('chunks at 100 ids per request and merges each chunk', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `asset-${i}`);

    makeServiceRequestSpy.mockImplementation(
      async (
        _method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        _url: string,
        data?: { ids: string[] },
      ): Promise<ServiceAssetMetadata[]> =>
        (data?.ids ?? []).map((id) => ({
          id,
          sha256: 'b'.repeat(64),
          mime: 'application/octet-stream',
          size: 1,
          status: 'active' as const,
        })),
    );

    const result = await oxy.getServiceAssetMetadataByIds(ids);

    // 250 unique ids => 100 + 100 + 50 across three POSTs.
    expect(makeServiceRequestSpy).toHaveBeenCalledTimes(3);
    const chunkSizes = makeServiceRequestSpy.mock.calls.map(
      (call) => (call[2] as { ids: string[] }).ids.length,
    );
    expect(chunkSizes).toEqual([100, 100, 50]);

    expect(result).toHaveLength(250);
    expect(result[0]).toEqual({
      id: 'asset-0',
      sha256: 'b'.repeat(64),
      mime: 'application/octet-stream',
      size: 1,
      status: 'active',
    });
    expect(result[249]?.id).toBe('asset-249');
  });

  it('THROWS when a chunk fails, so a failed request is never read as absence', async () => {
    // The load-bearing assertion. The server legitimately omits unknown/deleted
    // ids, so a short result is normal — which is exactly why a chunk that 429s
    // must not just contribute nothing. Swallowing it made a throttled request
    // indistinguishable from "those assets do not exist".
    const ids = Array.from({ length: 150 }, (_, i) => `asset-${i}`);

    makeServiceRequestSpy
      .mockResolvedValueOnce([sampleEntry]) // first chunk (100 ids) succeeds
      .mockRejectedValueOnce(new Error('chunk failed')); // second chunk (50 ids) fails

    await expect(oxy.getServiceAssetMetadataByIds(ids)).rejects.toThrow(ServiceAssetMetadataError);
    expect(makeServiceRequestSpy).toHaveBeenCalledTimes(2);
  });

  it('names every id of the failed chunk on the error', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `asset-${i}`);

    makeServiceRequestSpy
      .mockResolvedValueOnce([sampleEntry])
      .mockRejectedValueOnce(Object.assign(new Error('rate limited'), {
        response: { status: 429 },
      }));

    const error = await oxy.getServiceAssetMetadataByIds(ids).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceAssetMetadataError);
    const typed = error as ServiceAssetMetadataError;
    // The whole chunk is unresolved: which of those ids the server would have
    // omitted anyway is unknowable when the request never landed.
    expect(typed.unresolvedIds).toHaveLength(50);
    expect(typed.unresolvedIds).toContain('asset-100');
    expect(typed.unresolvedIds).not.toContain('asset-0');
    expect(typed.statuses).toEqual([429]);
    expect(typed.code).toBe('SERVICE_ASSET_METADATA_UNRESOLVED');
  });

  it('returns the resolved entries when the caller opts into { partial: true }', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `asset-${i}`);

    makeServiceRequestSpy
      .mockResolvedValueOnce([sampleEntry])
      .mockRejectedValueOnce(new Error('chunk failed'));

    const result = await oxy.getServiceAssetMetadataByIds(ids, { partial: true });

    expect(makeServiceRequestSpy).toHaveBeenCalledTimes(2);
    expect(result).toEqual([sampleEntry]);
  });

  it('does not throw when every chunk succeeds, with or without partial', async () => {
    makeServiceRequestSpy.mockResolvedValue([sampleEntry]);

    await expect(oxy.getServiceAssetMetadataByIds(['asset-1'])).resolves.toEqual([sampleEntry]);
    await expect(
      oxy.getServiceAssetMetadataByIds(['asset-1'], { partial: true }),
    ).resolves.toEqual([sampleEntry]);
  });
});
