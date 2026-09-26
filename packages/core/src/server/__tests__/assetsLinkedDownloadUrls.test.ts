/**
 * `getServiceLinkedDownloadUrls` mixin tests.
 *
 * Stubs `serviceRequest` (the service-token transport the route's
 * `serviceAuthMiddleware` + `files:linked:read` scope require) so these run with
 * no network and no `serviceToken()` round-trip.
 *
 * The contract worth guarding here is not the transport — the metadata sibling
 * already pins that shape — it is the TWO absences this method has to keep
 * distinguishable, because conflating them misinforms a person who paid money:
 *
 *   - The server OMITS an id it will not mint for, with no way to tell "no such
 *     file" from "not yours". That is a legitimate short result, and the caller
 *     has to map by `id`.
 *   - A FAILED chunk is not that. It throws, with no `{ partial: true }` escape
 *     hatch, because the sibling's best-effort mode would make a 429
 *     indistinguishable from the refusal above.
 */

import type { ServiceLinkedDownloadUrl } from '../../models/interfaces';
import { OxyServer } from '../OxyServer';
import { ServiceLinkedDownloadUrlError } from '../../OxyServices.errors';

const sampleEntry: ServiceLinkedDownloadUrl = {
  id: 'asset-1',
  url: 'https://s3.example/private/asset-1.stl?X-Amz-Signature=deadbeef',
  expiresIn: 300,
  mime: 'model/stl',
  size: 4096,
  sha256: 'a'.repeat(64),
};

describe('OxyServer.assets.linkedDownloadUrls', () => {
  let oxy: OxyServer;
  let serviceRequestSpy: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServer({ baseURL: 'http://test.invalid' });
    serviceRequestSpy = jest.spyOn(oxy, 'serviceRequest');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns [] and performs no network call for empty / whitespace input', async () => {
    await expect(oxy.assets.linkedDownloadUrls([])).resolves.toEqual([]);
    await expect(oxy.assets.linkedDownloadUrls(['', '   '])).resolves.toEqual([]);
    expect(serviceRequestSpy).not.toHaveBeenCalled();
  });

  it('POSTs de-duplicated ids to /assets/service/linked-url as { ids }', async () => {
    serviceRequestSpy.mockResolvedValueOnce([sampleEntry]);

    await oxy.assets.linkedDownloadUrls(['asset-1', 'asset-1', '  ']);

    expect(serviceRequestSpy).toHaveBeenCalledTimes(1);
    expect(serviceRequestSpy).toHaveBeenCalledWith(
      'POST',
      '/assets/service/linked-url',
      { ids: ['asset-1'] },
    );
  });

  it('returns entries untouched, so expiresIn and url reach the caller as sent', async () => {
    serviceRequestSpy.mockResolvedValueOnce([sampleEntry]);

    const [entry] = await oxy.assets.linkedDownloadUrls(['asset-1']);

    expect(entry).toEqual(sampleEntry);
  });

  it('chunks at 25, a QUARTER of the metadata route\'s 100', async () => {
    // The cap is the route's, and the two routes deliberately differ: this one
    // mints a credential per id. A client chunking at 100 would 400 every call.
    const ids = Array.from({ length: 26 }, (_, index) => `asset-${index}`);
    serviceRequestSpy.mockResolvedValue([]);

    await oxy.assets.linkedDownloadUrls(ids);

    expect(serviceRequestSpy).toHaveBeenCalledTimes(2);
    const sent = serviceRequestSpy.mock.calls.map(
      (call) => (call[2] as { ids: string[] }).ids.length,
    );
    expect(sent.sort((a, b) => b - a)).toEqual([25, 1]);
  });

  it('accepts a SHORT result without complaint — an omitted id is a refusal', async () => {
    // The server gives no URL for a file the owner did not link here, and says so
    // by saying nothing. A method that treated a short result as an error would
    // make the normal case throw.
    serviceRequestSpy.mockResolvedValueOnce([sampleEntry]);

    const entries = await oxy.assets.linkedDownloadUrls(['asset-1', 'asset-refused']);

    expect(entries.map((entry) => entry.id)).toEqual(['asset-1']);
  });

  it('THROWS on a failed chunk, naming its ids', async () => {
    const failure = Object.assign(new Error('Too Many Requests'), {
      response: { status: 429 },
    });
    serviceRequestSpy.mockRejectedValueOnce(failure);

    await expect(oxy.assets.linkedDownloadUrls(['asset-1'])).rejects.toThrow(
      ServiceLinkedDownloadUrlError,
    );

    serviceRequestSpy.mockRejectedValueOnce(failure);
    const error = await oxy
      .assets.linkedDownloadUrls(['asset-1'])
      .catch((caught: unknown) => caught as ServiceLinkedDownloadUrlError);

    expect(error.unresolvedIds).toEqual(['asset-1']);
    expect(error.statuses).toEqual([429]);
    expect(error.code).toBe('SERVICE_LINKED_DOWNLOAD_URL_UNRESOLVED');
  });

  it('throws even when OTHER chunks succeeded — a partial answer is not an answer', async () => {
    // The inverse of the sibling's `{ partial: true }`. Returning the 25 that
    // worked and dropping the one that did not is exactly how a buyer is told a
    // file they own is missing, so there is no option to ask for it.
    const ids = Array.from({ length: 26 }, (_, index) => `asset-${index}`);
    serviceRequestSpy
      .mockResolvedValueOnce([sampleEntry])
      .mockRejectedValueOnce(new Error('boom'));

    await expect(oxy.assets.linkedDownloadUrls(ids)).rejects.toThrow(
      ServiceLinkedDownloadUrlError,
    );
  });

  it('has no partial option at all', async () => {
    // Asserted on the ARITY rather than by passing an option and watching it be
    // ignored: a future signature that quietly accepted `{ partial: true }` would
    // restore the behaviour this method exists to refuse.
    expect(oxy.assets.linkedDownloadUrls.length).toBe(1);
  });
});
