/**
 * `OxyServer.assets` — application-owned files (ADR 0043) and the user-media
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

describe('OxyServer.assets.references — the calling application’s uses of files', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const reference = (index: number) => ({
    fileId: `file-${index}`,
    entityType: 'listing',
    entityId: `listing-${index}`,
  });

  it('add POSTs the batch to /assets/service/references and returns the per-item results', async () => {
    const oxy = new OxyServer({ baseURL: 'http://test.invalid' });
    const results = [{ ...reference(1), result: 'created' }];
    const spy = jest.spyOn(oxy, 'serviceRequest').mockResolvedValueOnce({ results });

    await expect(oxy.assets.references.add([reference(1)])).resolves.toEqual(results);

    const [method, url, body, options] = spy.mock.calls[0];
    expect([method, url, body]).toEqual([
      'POST',
      '/assets/service/references',
      { references: [reference(1)] },
    ]);
    expect(options.cache).toBe(false);
  });

  it('never sends an application: extra fields a caller passes are dropped', async () => {
    const oxy = new OxyServer({ baseURL: 'http://test.invalid' });
    const spy = jest.spyOn(oxy, 'serviceRequest').mockResolvedValueOnce({ results: [] });
    const smuggled = { ...reference(1), applicationId: 'someone-else' } as ReturnType<
      typeof reference
    >;

    await oxy.assets.references.remove([smuggled]);

    const [method, url, body] = spy.mock.calls[0];
    expect([method, url]).toEqual(['DELETE', '/assets/service/references']);
    expect(body).toEqual({ references: [reference(1)] });
  });

  it('splits a batch above 100 into ordered requests and concatenates the results in order', async () => {
    const oxy = new OxyServer({ baseURL: 'http://test.invalid' });
    const items = Array.from({ length: 150 }, (_, index) => reference(index));
    const spy = jest
      .spyOn(oxy, 'serviceRequest')
      .mockImplementation(async (_method, _url, body) => ({
        results: (body as { references: typeof items }).references.map((item) => ({
          ...item,
          result: 'removed',
        })),
      }));

    const results = await oxy.assets.references.remove(items);

    expect(spy).toHaveBeenCalledTimes(2);
    expect((spy.mock.calls[0][2] as { references: unknown[] }).references).toHaveLength(100);
    expect((spy.mock.calls[1][2] as { references: unknown[] }).references).toHaveLength(50);
    expect(results.map((item) => item.fileId)).toEqual(items.map((item) => item.fileId));
  });

  it('sends nothing for an empty batch', async () => {
    const oxy = new OxyServer({ baseURL: 'http://test.invalid' });
    const spy = jest.spyOn(oxy, 'serviceRequest');

    await expect(oxy.assets.references.add([])).resolves.toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('OxyServer.assets.references.reconcile — an inventory of one entity type (ADR 0043 D6)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const pair = (index: number) => ({ fileId: `file-${index}`, entityId: `listing-${index}` });
  const committed = {
    sessionId: 'session-1',
    entityType: 'listing',
    dryRun: false,
    added: 1,
    removed: 2,
    unchanged: 3,
    refused: 0,
  };

  function stubServer() {
    const oxy = new OxyServer({ baseURL: 'http://test.invalid' });
    const spy = jest
      .spyOn(oxy, 'serviceRequest')
      .mockImplementation(async (method: string, url: string) => {
        if (method === 'POST' && url === '/assets/service/references/reconcile') {
          return { sessionId: 'session-1', entityType: 'listing', expiresAt: 'x' };
        }
        if (method === 'POST' && url.endsWith('/commit')) return committed;
        return { accepted: 0, total: 0 };
      });
    return { oxy, spy };
  }

  it('begins, pages an async iterable in pages of 1000, and commits', async () => {
    const { oxy, spy } = stubServer();
    async function* inventory() {
      for (let index = 0; index < 2500; index += 1) yield pair(index);
    }

    await expect(oxy.assets.references.reconcile('listing', inventory())).resolves.toEqual(
      committed,
    );

    const calls = spy.mock.calls.map(([method, url, body]) => ({ method, url, body }));
    expect(calls[0]).toEqual({
      method: 'POST',
      url: '/assets/service/references/reconcile',
      body: { entityType: 'listing' },
    });
    const pages = calls.filter((call) => call.method === 'PUT');
    expect(pages.map((call) => (call.body as { items: unknown[] }).items.length)).toEqual([
      1000, 1000, 500,
    ]);
    expect(
      pages.every((call) => call.url === '/assets/service/references/reconcile/session-1'),
    ).toBe(true);
    expect(calls.at(-1)).toEqual({
      method: 'POST',
      url: '/assets/service/references/reconcile/session-1/commit',
      body: { dryRun: false, background: true },
    });
    // The begin is never retried: a retry of one that succeeded would 409 on itself.
    expect(spy.mock.calls[0][3].retry).toBe(false);
    // A page and the commit each get a budget above the default request's.
    expect(spy.mock.calls.find(([method]) => method === 'PUT')?.[3].timeout).toBe(30_000);
    expect(spy.mock.calls.at(-1)?.[3]).toMatchObject({ retry: false, timeout: 30_000 });
  });

  it('passes dryRun and sends only fileId and entityId', async () => {
    const { oxy, spy } = stubServer();
    const smuggled = { ...pair(1), applicationId: 'other' } as ReturnType<typeof pair>;

    await oxy.assets.references.reconcile('listing', [smuggled], { dryRun: true });

    const put = spy.mock.calls.find(([method]) => method === 'PUT');
    expect(put?.[2]).toEqual({ items: [pair(1)] });
    const commitCall = spy.mock.calls.find(([, url]) => String(url).endsWith('/commit'));
    expect(commitCall?.[2]).toEqual({ dryRun: true, background: true });
  });

  it('releases the session after a dry run, so the next reconciliation can begin', async () => {
    const { oxy, spy } = stubServer();

    await oxy.assets.references.reconcile('listing', [pair(1)], { dryRun: true });

    expect(spy.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      'DELETE',
      '/assets/service/references/reconcile/session-1',
    ]);
  });

  it('does not release after a real commit (Oxy has closed it)', async () => {
    const { oxy, spy } = stubServer();

    await oxy.assets.references.reconcile('listing', [pair(1)]);

    expect(spy.mock.calls.some(([method]) => method === 'DELETE')).toBe(false);
  });

  describe('a commit Oxy runs in the background', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    function stubBackground(states: object[]) {
      const oxy = new OxyServer({ baseURL: 'http://test.invalid' });
      const spy = jest
        .spyOn(oxy, 'serviceRequest')
        .mockImplementation(async (method: string, url: string) => {
          if (method === 'POST' && url === '/assets/service/references/reconcile') {
            return { sessionId: 'session-1', entityType: 'listing', expiresAt: 'x' };
          }
          if (method === 'POST' && url.endsWith('/commit')) {
            return {
              sessionId: 'session-1',
              entityType: 'listing',
              dryRun: false,
              status: 'committing',
            };
          }
          if (method === 'GET') return states.shift();
          return { accepted: 0, total: 0 };
        });
      return { oxy, spy };
    }

    const committing = {
      sessionId: 'session-1',
      entityType: 'listing',
      status: 'committing',
      result: null,
      error: null,
    };

    it('polls GET until it settles, and resolves to its counts', async () => {
      const { oxy, spy } = stubBackground([
        committing,
        {
          ...committing,
          status: 'committed',
          result: { dryRun: false, added: 4, removed: 1, unchanged: 2, refused: 0 },
        },
      ]);

      const pending = oxy.assets.references.reconcile('listing', [pair(1)]);
      await jest.advanceTimersByTimeAsync(10_000);

      await expect(pending).resolves.toEqual({
        sessionId: 'session-1',
        entityType: 'listing',
        dryRun: false,
        added: 4,
        removed: 1,
        unchanged: 2,
        refused: 0,
      });
      expect(spy.mock.calls.filter(([method]) => method === 'GET')).toHaveLength(2);
      expect(spy.mock.calls.filter(([method]) => method === 'GET')[0][1]).toBe(
        '/assets/service/references/reconcile/session-1',
      );
    });

    it('rejects with the code of a commit that failed, and releases the session', async () => {
      const { oxy, spy } = stubBackground([
        {
          ...committing,
          status: 'open',
          error: {
            code: 'RECONCILIATION_COMMIT_FAILED',
            message: 'The commit failed; commit again',
          },
        },
      ]);

      const pending = oxy.assets.references.reconcile('listing', [pair(1)]);
      const assertion = expect(pending).rejects.toMatchObject({
        code: 'RECONCILIATION_COMMIT_FAILED',
      });
      await jest.advanceTimersByTimeAsync(5_000);
      await assertion;
      expect(spy.mock.calls.at(-1)?.slice(0, 2)).toEqual([
        'DELETE',
        '/assets/service/references/reconcile/session-1',
      ]);
    });
  });

  describe("Oxy's refusals (429)", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    const refusal = (retryAfterSeconds?: number) =>
      Object.assign(new Error('Too many reconciliation requests. Please slow down.'), {
        status: 429,
        code: 'RATE_LIMITED',
        ...(retryAfterSeconds === undefined ? {} : { details: { retryAfterSeconds } }),
      });

    /** A server that refuses the requests `refuse` picks, in order, then serves them. */
    function stubRefusing(refuse: (method: string, url: string) => Error | undefined) {
      const oxy = new OxyServer({ baseURL: 'http://test.invalid' });
      const sent: Array<{ method: string; url: string; at: number; body: unknown }> = [];
      const spy = jest
        .spyOn(oxy, 'serviceRequest')
        .mockImplementation(async (method: string, url: string, body?: unknown) => {
          const refused = refuse(method, url);
          if (refused) throw refused;
          sent.push({ method, url, at: Date.now(), body });
          if (method === 'POST' && url === '/assets/service/references/reconcile') {
            return { sessionId: 'session-1', entityType: 'listing', expiresAt: 'x' };
          }
          if (method === 'POST' && url.endsWith('/commit')) return committed;
          return { accepted: 0, total: 0 };
        });
      return { oxy, spy, sent };
    }

    it('waits out a refused page for the Retry-After Oxy names, and sends every page', async () => {
      let refusals = 1;
      const { oxy, sent } = stubRefusing((method) =>
        method === 'PUT' &&
        sent.filter((call) => call.method === 'PUT').length === 1 &&
        refusals-- > 0
          ? refusal(7)
          : undefined,
      );
      async function* inventory() {
        for (let index = 0; index < 2500; index += 1) yield pair(index);
      }

      const pending = oxy.assets.references.reconcile('listing', inventory());
      await jest.advanceTimersByTimeAsync(6_000);
      // Still waiting: Oxy said seven seconds.
      expect(sent.filter((call) => call.method === 'PUT')).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(5_000);

      await expect(pending).resolves.toEqual(committed);
      const pages = sent.filter((call) => call.method === 'PUT');
      expect(pages.map((call) => (call.body as { items: unknown[] }).items.length)).toEqual([
        1000, 1000, 500,
      ]);
      // The refused page went again, unchanged: nothing was dropped.
      expect((pages[1].body as { items: Array<{ fileId: string }> }).items[0].fileId).toBe(
        'file-1000',
      );
    });

    it('paces pages at least 300 ms apart', async () => {
      const { oxy, sent } = stubRefusing(() => undefined);
      async function* inventory() {
        for (let index = 0; index < 4000; index += 1) yield pair(index);
      }

      const pending = oxy.assets.references.reconcile('listing', inventory());
      await jest.advanceTimersByTimeAsync(5_000);
      await pending;

      const at = sent.filter((call) => call.method === 'PUT').map((call) => call.at);
      expect(at).toHaveLength(4);
      for (let index = 1; index < at.length; index += 1) {
        expect(at[index] - at[index - 1]).toBeGreaterThanOrEqual(300);
      }
    });

    it('waits out a refused release, so the session is let go', async () => {
      let releaseRefusals = 2;
      const { oxy, sent } = stubRefusing((method) =>
        method === 'DELETE' && releaseRefusals-- > 0 ? refusal(1) : undefined,
      );

      const pending = oxy.assets.references.reconcile('listing', [pair(1)], { dryRun: true });
      await jest.advanceTimersByTimeAsync(5_000);
      await pending;

      expect(sent.at(-1)).toMatchObject({
        method: 'DELETE',
        url: '/assets/service/references/reconcile/session-1',
      });
    });

    it('gives up after eight refusals of one page, releases, and rethrows the refusal', async () => {
      const { oxy, spy } = stubRefusing((method) => (method === 'PUT' ? refusal() : undefined));

      const pending = oxy.assets.references.reconcile('listing', [pair(1)]);
      const assertion = expect(pending).rejects.toMatchObject({ status: 429 });
      // 2, 4, 8, 16, 32 s then the 60 s cap three times.
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      await assertion;

      expect(spy.mock.calls.filter(([method]) => method === 'PUT')).toHaveLength(9);
      expect(spy.mock.calls.at(-1)?.slice(0, 2)).toEqual([
        'DELETE',
        '/assets/service/references/reconcile/session-1',
      ]);
      expect(spy.mock.calls.some(([, url]) => String(url).endsWith('/commit'))).toBe(false);
    });

    it('does not retry a failure that is not a refusal', async () => {
      const { oxy, spy } = stubRefusing((method) =>
        method === 'PUT' ? Object.assign(new Error('conflict'), { status: 409 }) : undefined,
      );

      await expect(oxy.assets.references.reconcile('listing', [pair(1)])).rejects.toMatchObject({
        status: 409,
      });
      expect(spy.mock.calls.filter(([method]) => method === 'PUT')).toHaveLength(1);
    });
  });

  it('releases the session when the inventory fails, then rethrows', async () => {
    const { oxy, spy } = stubServer();
    async function* failing() {
      yield pair(1);
      throw new Error('database went away');
    }

    await expect(oxy.assets.references.reconcile('listing', failing())).rejects.toThrow(
      'database went away',
    );
    expect(spy.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      'DELETE',
      '/assets/service/references/reconcile/session-1',
    ]);
    expect(spy.mock.calls.some(([, url]) => String(url).endsWith('/commit'))).toBe(false);
  });
});

describe('OxyServer.assets — import by URL (ADR 0043 D7)', () => {
  let oxy: OxyServer;
  let serviceRequestSpy: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServer({ baseURL: 'http://test.invalid' });
    serviceRequestSpy = jest.spyOn(oxy, 'serviceRequest');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('importAppFile POSTs the source and options as JSON, not retried, with a long timeout', async () => {
    const answer = {
      file,
      outcome: 'downloaded',
      deduplicated: false,
      source: { host: 'supplier.example', fetchedAt: '2026-10-16T00:00:00.000Z' },
    };
    serviceRequestSpy.mockResolvedValueOnce(answer);
    await expect(
      oxy.assets.importAppFile('https://supplier.example/a.png', {
        visibility: 'public',
        reference: { entityType: 'listing', entityId: 'l1' },
        revalidate: true,
      }),
    ).resolves.toEqual(answer);
    const [method, url, body, options] = serviceRequestSpy.mock.calls[0];
    expect([method, url, body]).toEqual([
      'POST',
      '/assets/service/app/import',
      {
        sourceUrl: 'https://supplier.example/a.png',
        visibility: 'public',
        reference: { entityType: 'listing', entityId: 'l1' },
        revalidate: true,
      },
    ]);
    expect(options).toMatchObject({ retry: false, cache: false });
    expect(options.timeout).toBeGreaterThan(60_000);
  });

  it('importAppFiles sends 50 per request and returns indexes into the whole list', async () => {
    const items = Array.from({ length: 120 }, (_, i) => ({
      sourceUrl: `https://supplier.example/${i}.png`,
      visibility: 'public' as const,
    }));
    serviceRequestSpy.mockImplementation(
      async (_m: string, _u: string, payload: { items: unknown[] }) => ({
        results: payload.items.map((_, index) => ({
          index,
          ok: false,
          error: { status: 502, code: 'X', message: 'x' },
        })),
      }),
    );
    const results = await oxy.assets.importAppFiles(items);
    expect(
      serviceRequestSpy.mock.calls.map((c) => (c[2] as { items: unknown[] }).items.length),
    ).toEqual([50, 50, 20]);
    expect(results.map((r) => r.index)).toEqual(items.map((_, i) => i));
    expect(serviceRequestSpy.mock.calls[0][1]).toBe('/assets/service/app/import/batch');
  });

  it('importUserMedia names the owner in x-owner-user-id, as the upload does', async () => {
    serviceRequestSpy.mockResolvedValueOnce({ file: {}, outcome: 'existing' });
    await oxy.assets.importUserMedia('user-1', 'https://supplier.example/a.png');
    const [method, url, body, options] = serviceRequestSpy.mock.calls[0];
    expect([method, url, body]).toEqual([
      'POST',
      '/assets/service/user-media/import',
      { sourceUrl: 'https://supplier.example/a.png' },
    ]);
    expect(options.headers).toEqual({ 'x-owner-user-id': 'user-1' });
  });

  it('adoptAppFile POSTs the source id, visibility and reference, naming no owner', async () => {
    const answer = {
      file,
      outcome: 'adopted',
      deduplicated: false,
      reference: { result: 'created' },
    };
    serviceRequestSpy.mockResolvedValueOnce(answer);

    await expect(
      oxy.assets.adoptAppFile('src-1', {
        visibility: 'private',
        reference: { entityType: 'deliverable', entityId: 'l-1' },
      }),
    ).resolves.toEqual(answer);

    const [method, url, body, options] = serviceRequestSpy.mock.calls[0];
    expect([method, url, body]).toEqual([
      'POST',
      '/assets/service/app/adopt',
      {
        fileId: 'src-1',
        visibility: 'private',
        reference: { entityType: 'deliverable', entityId: 'l-1' },
      },
    ]);
    expect(options.headers ?? {}).not.toHaveProperty('x-owner-user-id');
  });
});
