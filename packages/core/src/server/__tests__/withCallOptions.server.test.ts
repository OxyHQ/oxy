/**
 * `withCallOptions` on a server: the scope reaches the service lane (the
 * server's own namespaces), a person's client from `withUser`, and the
 * per-method `ServiceCallOptions` keep their meaning.
 */
import { OxyServer } from '../OxyServer';
import type { RequestOptions } from '../../HttpService';

function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 3600, ...payload })}.sig`;
}

const file = {
  id: 'file-1',
  sha256: 'a'.repeat(64),
  size: 1,
  mime: 'image/png',
  ext: '.png',
  ownerApplicationId: 'app-1',
  status: 'active' as const,
  visibility: 'public' as const,
  createdAt: 'now',
  updatedAt: 'now',
};

describe('OxyServer.withCallOptions', () => {
  let oxy: OxyServer;
  let serviceRequestSpy: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServer({ baseURL: 'http://test.invalid' });
    serviceRequestSpy = jest.spyOn(oxy, 'serviceRequest');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('applies to the server’s own namespaces, over the service lane', async () => {
    serviceRequestSpy.mockResolvedValueOnce({ file, deduplicated: false });

    await oxy
      .withCallOptions({ timeout: 45_000 })
      .assets.uploadAppFile(new Uint8Array([1]), 'image/png', {
        visibility: 'public',
      });

    const options = serviceRequestSpy.mock.calls[0][3] as RequestOptions;
    expect(serviceRequestSpy.mock.calls[0].slice(0, 2)).toEqual(['POST', '/assets/service/app']);
    expect(options.timeout).toBe(45_000);
    // The upload is sent once on purpose, whatever the scope says.
    expect(options.retry).toBe(false);
  });

  it('cannot re-enable retries on a write the method sends once', async () => {
    serviceRequestSpy.mockResolvedValueOnce({ file, deduplicated: false });

    await oxy
      .withCallOptions({ retry: true })
      .assets.uploadAppFile(new Uint8Array([1]), 'image/png', {
        visibility: 'public',
      });

    expect((serviceRequestSpy.mock.calls[0][3] as RequestOptions).retry).toBe(false);
  });

  it('gives the scoped namespaces the server namespace types', () => {
    const scoped = oxy.withCallOptions({ retry: false });
    expect(typeof scoped.assets.references.add).toBe('function');
    expect(typeof scoped.assets.metadataByIds).toBe('function');
  });

  it('keeps references.add’s own ServiceCallOptions', async () => {
    const results = [{ fileId: 'f1', entityType: 'post', entityId: 'p1', result: 'created' }];
    serviceRequestSpy.mockResolvedValueOnce({ results });

    await oxy.assets.references.add([{ fileId: 'f1', entityType: 'post', entityId: 'p1' }], {
      retry: false,
      timeout: 5_000,
    });

    expect(serviceRequestSpy.mock.calls[0][3]).toMatchObject({
      cache: false,
      retry: false,
      timeout: 5_000,
    });
  });

  it('applies to a person’s client from withUser, which still speaks as that person', async () => {
    const bearer = makeJwt({ userId: 'u1', sessionId: 's1' });
    let sent: (RequestOptions & { url: string }) | undefined;

    await oxy.withUser(bearer, async (user) => {
      jest.spyOn(user.http, 'request').mockImplementation(async (config) => {
        sent = config as RequestOptions & { url: string };
        return { file: { id: 'f1', visibility: 'public', updatedAt: 'now' } } as never;
      });
      await user.withCallOptions({ timeout: 60_000 }).assets.setVisibility('f1', 'public');
    });

    expect(sent).toMatchObject({ url: '/assets/f1/visibility', timeout: 60_000 });
    expect(sent?.headers?.Authorization).toBe(`Bearer ${bearer}`);
    expect(serviceRequestSpy).not.toHaveBeenCalled();
  });
});
