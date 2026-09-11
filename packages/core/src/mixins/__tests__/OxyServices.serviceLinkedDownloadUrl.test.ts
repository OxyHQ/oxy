/**
 * `getServiceLinkedDownloadUrls` mixin tests.
 *
 * Stubs `makeServiceRequest` (the service-token transport the route's
 * `serviceAuthMiddleware` + `files:linked:read` scope require) so these run with
 * no network and no `getServiceToken()` round-trip.
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
import { OxyServices } from '../../OxyServices';
import { ServiceLinkedDownloadUrlError } from '../../OxyServices.errors';

const sampleEntry: ServiceLinkedDownloadUrl = {
  id: 'asset-1',
  url: 'https://s3.example/private/asset-1.stl?X-Amz-Signature=deadbeef',
  expiresIn: 300,
  mime: 'model/stl',
  size: 4096,
  sha256: 'a'.repeat(64),
};

describe('OxyServices.assets — getServiceLinkedDownloadUrls', () => {
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
    await expect(oxy.getServiceLinkedDownloadUrls([])).resolves.toEqual([]);
    await expect(oxy.getServiceLinkedDownloadUrls(['', '   '])).resolves.toEqual([]);
    expect(makeServiceRequestSpy).not.toHaveBeenCalled();
  });

  it('POSTs de-duplicated ids to /assets/service/linked-url as { ids }', async () => {
    makeServiceRequestSpy.mockResolvedValueOnce([sampleEntry]);

    await oxy.getServiceLinkedDownloadUrls(['asset-1', 'asset-1', '  ']);

    expect(makeServiceRequestSpy).toHaveBeenCalledTimes(1);
    expect(makeServiceRequestSpy).toHaveBeenCalledWith(
      'POST',
      '/assets/service/linked-url',
      { ids: ['asset-1'] },
    );
  });

  it('returns entries untouched, so expiresIn and url reach the caller as sent', async () => {
    makeServiceRequestSpy.mockResolvedValueOnce([sampleEntry]);

    const [entry] = await oxy.getServiceLinkedDownloadUrls(['asset-1']);

    expect(entry).toEqual(sampleEntry);
  });

  it('chunks at 25, a QUARTER of the metadata route\'s 100', async () => {
    // The cap is the route's, and the two routes deliberately differ: this one
    // mints a credential per id. A client chunking at 100 would 400 every call.
    const ids = Array.from({ length: 26 }, (_, index) => `asset-${index}`);
    makeServiceRequestSpy.mockResolvedValue([]);

    await oxy.getServiceLinkedDownloadUrls(ids);

    expect(makeServiceRequestSpy).toHaveBeenCalledTimes(2);
    const sent = makeServiceRequestSpy.mock.calls.map(
      (call) => (call[2] as { ids: string[] }).ids.length,
    );
    expect(sent.sort((a, b) => b - a)).toEqual([25, 1]);
  });

  it('accepts a SHORT result without complaint — an omitted id is a refusal', async () => {
    // The server gives no URL for a file the owner did not link here, and says so
    // by saying nothing. A method that treated a short result as an error would
    // make the normal case throw.
    makeServiceRequestSpy.mockResolvedValueOnce([sampleEntry]);

    const entries = await oxy.getServiceLinkedDownloadUrls(['asset-1', 'asset-refused']);

    expect(entries.map((entry) => entry.id)).toEqual(['asset-1']);
  });

  it('THROWS on a failed chunk, naming its ids', async () => {
    const failure = Object.assign(new Error('Too Many Requests'), {
      response: { status: 429 },
    });
    makeServiceRequestSpy.mockRejectedValueOnce(failure);

    await expect(oxy.getServiceLinkedDownloadUrls(['asset-1'])).rejects.toThrow(
      ServiceLinkedDownloadUrlError,
    );

    makeServiceRequestSpy.mockRejectedValueOnce(failure);
    const error = await oxy
      .getServiceLinkedDownloadUrls(['asset-1'])
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
    makeServiceRequestSpy
      .mockResolvedValueOnce([sampleEntry])
      .mockRejectedValueOnce(new Error('boom'));

    await expect(oxy.getServiceLinkedDownloadUrls(ids)).rejects.toThrow(
      ServiceLinkedDownloadUrlError,
    );
  });

  it('has no partial option at all', async () => {
    // Asserted on the ARITY rather than by passing an option and watching it be
    // ignored: a future signature that quietly accepted `{ partial: true }` would
    // restore the behaviour this method exists to refuse.
    expect(oxy.getServiceLinkedDownloadUrls.length).toBe(1);
  });
});
