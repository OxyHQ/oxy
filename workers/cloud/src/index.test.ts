import { describe, expect, it } from 'bun:test';
import { type Deps, type Env, EDGE_CACHE_MAX_BYTES, handle, resolverCacheTag } from './index';
import {
  DOWNLOAD_POLICY,
  IMMUTABLE_CACHE_CONTROL,
  SVG_POLICY,
  canonicalRenditionPath,
  routeFor,
} from './policy';

type Stored = {
  body: string;
  contentType?: string;
  cacheControl?: string;
  disposition?: string;
  size?: number;
};

/** The slice of R2Bucket the Worker uses, over a map of keys. */
function fakeBucket(objects: Record<string, Stored>, beforeFullRead?: () => Promise<void>) {
  const reads: string[] = [];
  const object = (key: string, stored: Stored, range?: { offset: number; length: number }) => {
    const bytes = new TextEncoder().encode(stored.body);
    const slice = range ? bytes.slice(range.offset, range.offset + range.length) : bytes;
    return {
      key,
      size: stored.size ?? bytes.length,
      httpEtag: '"etag"',
      uploaded: new Date('2026-10-01T00:00:00Z'),
      range,
      writeHttpMetadata(headers: Headers) {
        if (stored.contentType) headers.set('content-type', stored.contentType);
        if (stored.cacheControl) headers.set('cache-control', stored.cacheControl);
        if (stored.disposition) headers.set('content-disposition', stored.disposition);
      },
      body: new Response(slice).body,
    };
  };
  const bucket = {
    async head(key: string) {
      reads.push(`head ${key}`);
      const stored = objects[key];
      if (!stored) return null;
      const { body: _body, ...rest } = object(key, stored);
      return rest;
    },
    async get(key: string, options?: { range?: Headers; onlyIf?: Headers }) {
      reads.push(`get ${key}`);
      const stored = objects[key];
      if (!stored) return null;
      if (!options?.range) await beforeFullRead?.();
      if (options?.onlyIf?.get('if-none-match') === '"etag"') {
        const { body: _body, ...rest } = object(key, stored);
        return rest;
      }
      const header = options?.range?.get('range');
      const match = header ? /^bytes=(\d+)-(\d+)$/.exec(header) : null;
      if (header && (!match || Number(match[1]) >= (stored.size ?? stored.body.length))) {
        throw new Error('The requested range is not satisfiable');
      }
      const range = match
        ? { offset: Number(match[1]), length: Number(match[2]) - Number(match[1]) + 1 }
        : undefined;
      return object(key, stored, range);
    },
  };
  return { bucket: bucket as unknown as R2Bucket, reads };
}

/** A Cache keyed by URL that remembers what was put. */
function fakeCache() {
  const entries = new Map<string, Response>();
  const cache = {
    async match(request: Request) {
      const hit = entries.get(request.url);
      if (!hit) return undefined;
      const ifNoneMatch = request.headers.get('if-none-match');
      if (ifNoneMatch && ifNoneMatch === hit.headers.get('etag')) {
        return new Response(null, { status: 304, headers: hit.headers });
      }
      const range = request.headers.get('range');
      const match = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
      if (!match) return hit.clone();
      const body = await hit.clone().arrayBuffer();
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), body.byteLength - 1);
      const headers = new Headers(hit.headers);
      if (start >= body.byteLength) {
        headers.set('content-range', `bytes */${body.byteLength}`);
        return new Response(null, { status: 416, headers });
      }
      headers.set('content-range', `bytes ${start}-${end}/${body.byteLength}`);
      headers.set('content-length', String(end - start + 1));
      return new Response(body.slice(start, end + 1), { status: 206, headers });
    },
    async put(request: Request, response: Response) {
      entries.set(request.url, response.clone());
    },
  };
  return { cache: cache as unknown as Cache, entries };
}

function harness(
  objects: Record<string, Stored>,
  upstream?: (url: string) => Response,
  websiteObjects: Record<string, Stored> = {},
  beforeFullRead?: () => Promise<void>,
) {
  const { bucket, reads } = fakeBucket(objects, beforeFullRead);
  const website = fakeBucket(websiteObjects);
  const { cache, entries } = fakeCache();
  const pending: Promise<unknown>[] = [];
  const fetched: string[] = [];
  const env: Env = {
    FILES: bucket,
    WEBSITE_LEGACY: website.bucket,
    API_ORIGIN: 'https://api.oxy.so',
  };
  const deps: Deps = {
    cache,
    waitUntil: (promise) => pending.push(promise),
    fetch: async (input: string) => {
      const url = String(input);
      fetched.push(url);
      return upstream ? upstream(url) : new Response('{"error":"NOT_FOUND"}', { status: 404 });
    },
  };
  const get = async (path: string, init?: RequestInit) => {
    const response = await handle(new Request(`https://cloud.oxy.so${path}`, init), env, deps);
    await Promise.all(pending);
    return response;
  };
  return { get, reads, entries, fetched, env, deps, pending };
}

describe('routing: the CloudFront behaviors, in order', () => {
  it('reads object paths under public/ and sends everything else to the resolver', () => {
    expect(routeFor('/content/2026/10/ab/x.png')).toEqual({
      kind: 'object',
      bucket: 'files',
      key: 'public/content/2026/10/ab/x.png',
      defaultCacheControl: IMMUTABLE_CACHE_CONTROL,
    });
    expect(routeFor('/variants/2026/10/ab/sha/thumb.webp')).toMatchObject({
      kind: 'object',
      key: 'public/variants/2026/10/ab/sha/thumb.webp',
    });
    expect(routeFor('/variants/2026/10/ab/sha/hls_master.m3u8')).toEqual({
      kind: 'object',
      bucket: 'files',
      key: 'public/variants/2026/10/ab/sha/hls_master.m3u8',
      defaultCacheControl: null,
    });
    expect(routeFor('/oxy-website/images/logo-1234.png')).toEqual({
      kind: 'object',
      bucket: 'website',
      key: 'public/oxy-website/images/logo-1234.png',
      defaultCacheControl: null,
    });
    expect(routeFor('/01a15c7d-5a0a-719f-a2bd-2655fc7b1962')).toEqual({ kind: 'resolver' });
    expect(routeFor('/')).toEqual({ kind: 'resolver' });
  });

  it('never names a key outside public/, whatever the path spells', () => {
    for (const path of [
      '/content/../user/x',
      '/content/%2e%2e/user/x',
      '/variants//x',
      '/content/%00',
    ]) {
      const route = routeFor(path);
      if (route.kind === 'object') expect(route.key.startsWith('public/')).toBe(true);
    }
  });
});

describe('objects', () => {
  it('serves a public object with its type, the immutable year, CORS and nosniff', async () => {
    const { get } = harness({ 'public/content/a.png': { body: 'png', contentType: 'image/png' } });
    const response = await get('/content/a.png');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('png');
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-disposition')).toBeNull();
  });

  it('a private file is not reachable: its key is not under public/', async () => {
    const { get, reads } = harness({
      'content/secret.png': { body: 'private', contentType: 'image/png' },
    });
    const response = await get('/content/secret.png');
    expect(response.status).toBe(404);
    expect(reads).toEqual(['get public/content/secret.png']);
  });

  it("keeps a playlist's own short Cache-Control", async () => {
    const { get } = harness({
      'public/variants/v/hls_master.m3u8': {
        body: '#EXTM3U',
        contentType: 'application/vnd.apple.mpegurl',
        cacheControl: 'public, max-age=3600',
      },
    });
    const response = await get('/variants/v/hls_master.m3u8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(response.headers.get('content-disposition')).toBeNull();
  });

  it('serves a non-media file as a sandboxed download, keeping a stored filename', async () => {
    const { get } = harness({
      'public/content/page.html': { body: '<script>', contentType: 'text/html' },
      'public/content/doc.zip': {
        body: 'zip',
        contentType: 'application/zip',
        disposition: 'attachment; filename="doc.zip"',
      },
    });
    const html = await get('/content/page.html');
    expect(html.headers.get('content-disposition')).toBe('attachment');
    expect(html.headers.get('content-security-policy')).toBe(DOWNLOAD_POLICY);
    const zip = await get('/content/doc.zip');
    expect(zip.headers.get('content-disposition')).toBe('attachment; filename="doc.zip"');
  });

  it('renders a sanitized SVG inline under the sandboxing CSP', async () => {
    const { get } = harness({
      'public/content/x.svg': {
        body: '<svg/>',
        contentType: 'image/svg+xml',
        disposition: 'attachment',
      },
    });
    const response = await get('/content/x.svg');
    expect(response.headers.get('content-disposition')).toBeNull();
    expect(response.headers.get('content-security-policy')).toBe(SVG_POLICY);
  });

  it('answers a range with 206 and fills the edge cache', async () => {
    const { get, entries } = harness({
      'public/content/v.mp4': { body: '0123456789', contentType: 'video/mp4' },
    });
    const response = await get('/content/v.mp4', { headers: { range: 'bytes=2-5' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(response.headers.get('content-length')).toBe('4');
    expect(await response.text()).toBe('2345');
    expect(entries.has('https://cloud.oxy.so/content/v.mp4')).toBe(true);
  });

  it('serves cold ranges before the complete object arrives and fills only once', async () => {
    let finishRead = () => {};
    const fullRead = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    let fullReads = 0;
    const { env, deps, pending, entries } = harness(
      { 'public/content/cold.mp4': { body: '0123456789', contentType: 'video/mp4' } },
      undefined,
      {},
      () => {
        fullReads++;
        return fullRead;
      },
    );
    try {
      for (const range of ['bytes=0-1', 'bytes=2-3']) {
        const response = await handle(
          new Request('https://cloud.oxy.so/content/cold.mp4', { headers: { range } }),
          env,
          deps,
        );
        expect(response.status).toBe(206);
        expect(await response.text()).toBe(range === 'bytes=0-1' ? '01' : '23');
      }
      expect(fullReads).toBe(1);
      expect(pending).toHaveLength(1);
      expect(entries.size).toBe(0);
    } finally {
      finishRead();
      await Promise.all(pending);
    }
    expect(entries.has('https://cloud.oxy.so/content/cold.mp4')).toBe(true);
  }, 1000);

  it('answers a warm range from the complete cached object without another R2 read', async () => {
    const { get, reads } = harness({
      'public/content/warm.mp4': { body: '0123456789', contentType: 'video/mp4' },
    });
    await get('/content/warm.mp4');
    const response = await get('/content/warm.mp4', { headers: { range: 'bytes=4-7' } });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('4567');
    expect(reads).toEqual(['get public/content/warm.mp4']);
  });

  it('does not fill objects above the cache size limit', async () => {
    let fullReads = 0;
    const { get, pending } = harness(
      {
        'public/content/large.mp4': {
          body: '0123456789',
          contentType: 'video/mp4',
          size: EDGE_CACHE_MAX_BYTES + 1,
        },
      },
      undefined,
      {},
      async () => {
        fullReads++;
      },
    );
    const response = await get('/content/large.mp4', { headers: { range: 'bytes=0-1' } });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('01');
    expect(fullReads).toBe(0);
    expect(pending).toHaveLength(0);
  });

  it('preserves a ranged conditional response without downloading the complete object', async () => {
    const { get, pending } = harness({
      'public/content/conditional.mp4': { body: '0123456789', contentType: 'video/mp4' },
    });
    const response = await get('/content/conditional.mp4', {
      headers: { range: 'bytes=0-1', 'if-none-match': '"etag"' },
    });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe('');
    expect(pending).toHaveLength(0);
  });

  it('rejects an unsatisfiable range without filling the cache', async () => {
    const { get, pending } = harness({
      'public/content/invalid.mp4': { body: '0123456789', contentType: 'video/mp4' },
    });
    const response = await get('/content/invalid.mp4', { headers: { range: 'bytes=20-30' } });
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */10');
    expect(pending).toHaveLength(0);
  });

  it('caches by path alone, as S3 ignored the query string', async () => {
    const { get, entries } = harness({
      'public/content/a.png': { body: 'png', contentType: 'image/png' },
    });
    await get('/content/a.png?x=1');
    expect([...entries.keys()]).toEqual(['https://cloud.oxy.so/content/a.png']);
  });

  it('HEAD answers the headers without a body', async () => {
    const { get } = harness({ 'public/content/a.png': { body: 'png', contentType: 'image/png' } });
    const response = await get('/content/a.png', { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('3');
  });
});

describe("the website's legacy images", () => {
  it('are read from their own bucket, never from Oxy Files', async () => {
    const { get, reads } = harness(
      { 'public/oxy-website/images/a.png': { body: 'stale copy', contentType: 'image/png' } },
      undefined,
      { 'public/oxy-website/images/a.png': { body: 'website', contentType: 'image/png' } },
    );
    const response = await get('/oxy-website/images/a.png');
    expect(await response.text()).toBe('website');
    expect(reads).toEqual([]);
  });
});

describe('the by-id resolver', () => {
  const redirect = () =>
    new Response('', {
      status: 302,
      headers: {
        location: 'https://cloud.oxy.so/content/a.png',
        'cache-control': 'public, max-age=3600, stale-while-revalidate=86400',
      },
    });

  it("forwards only `variant` and keeps oxy-api's Cache-Control exactly", async () => {
    const { get, fetched } = harness({}, redirect);
    const response = await get('/abc?variant=thumb&utm=x');
    expect(fetched).toEqual(['https://api.oxy.so/cdn/abc?variant=thumb']);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://cloud.oxy.so/content/a.png');
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=3600, stale-while-revalidate=86400',
    );
    expect(response.headers.get('accept-ranges')).toBe('none');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('keeps a redirect per variant, tagged with the file id so oxy-api can purge them all', async () => {
    const { get, entries, fetched } = harness({}, redirect);
    await get('/abc?variant=thumb');
    await get('/abc?variant=thumb');
    expect(fetched).toHaveLength(1);
    const stored = entries.get('https://cloud.oxy.so/abc?variant=thumb');
    expect(stored?.headers.get('cache-tag')).toBe(resolverCacheTag('/abc'));
    const hit = await get('/abc?variant=thumb');
    expect(hit.headers.get('cache-tag')).toBeNull();
  });

  it('never keeps a 404, so a file published a moment later resolves at once', async () => {
    const { get, entries } = harness({});
    const response = await get('/abc');
    expect(response.status).toBe(404);
    expect(entries.size).toBe(0);
  });
});

describe('lengths', () => {
  it("declares every body's length, so a Sippy stream keeps Content-Length and the cache can range it", async () => {
    const declared: number[] = [];
    const original = (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream;
    (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class {
      readable: ReadableStream;
      writable: WritableStream;
      constructor(length: number) {
        declared.push(length);
        const pipe = new TransformStream();
        this.readable = pipe.readable;
        this.writable = pipe.writable;
      }
    };
    try {
      const { get } = harness({
        'public/content/v.mp4': { body: '0123456789', contentType: 'video/mp4' },
      });
      expect(await (await get('/content/v.mp4')).text()).toBe('0123456789');
      expect(declared).toEqual([10]);
    } finally {
      (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = original;
    }
  });
});

describe('methods', () => {
  it('answers a CORS preflight', async () => {
    const { get } = harness({});
    const response = await get('/content/a.png', { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, HEAD');
  });

  it('refuses writes', async () => {
    const { get } = harness({});
    expect((await get('/content/a.png', { method: 'PUT', body: 'x' })).status).toBe(405);
  });
});

describe('renditions asked through a pre-rewrite HLS master', () => {
  const dir = `2026/07/1f/${'1f'.repeat(32)}`;
  const doubled = (name: string) => `/variants/${dir}/public/variants/${dir}/${name}`;
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nhls_360p.m3u8\n';
  const rendition = '#EXTM3U\n#EXTINF:9.6,\nsegment_360p_000.ts\n#EXT-X-ENDLIST\n';
  const objects = {
    [`public/variants/${dir}/hls_master.m3u8`]: {
      body: master,
      contentType: 'application/vnd.apple.mpegurl',
      cacheControl: 'public, max-age=3600',
    },
    [`public/variants/${dir}/hls_360p.m3u8`]: {
      body: rendition,
      contentType: 'application/vnd.apple.mpegurl',
      cacheControl: 'public, max-age=31536000, immutable',
    },
    [`public/variants/${dir}/segment_360p_000.ts`]: { body: 'TS', contentType: 'video/mp2t' },
  };

  it('is how a relative storage-key URI resolved against the master URL', () => {
    // The old master's URI line was the rendition's storage key.
    const resolved = new URL(
      `public/variants/${dir}/hls_360p.m3u8`,
      `https://cloud.oxy.so/variants/${dir}/hls_master.m3u8`,
    );
    expect(resolved.pathname).toBe(doubled('hls_360p.m3u8'));
    // Its segments resolve under the doubled directory too.
    expect(new URL('segment_360p_000.ts', resolved).pathname).toBe(doubled('segment_360p_000.ts'));
  });

  it('serves the doubled rendition and its segments from the canonical objects', async () => {
    const { get, reads, entries } = harness(objects);

    const playlist = await get(doubled('hls_360p.m3u8'));
    expect(playlist.status).toBe(200);
    expect(await playlist.text()).toBe(rendition);
    expect(playlist.headers.get('link')).toBe(
      `<https://cloud.oxy.so/variants/${dir}/hls_360p.m3u8>; rel="canonical"`,
    );
    expect(playlist.headers.get('access-control-allow-origin')).toBe('*');

    const segment = await get(doubled('segment_360p_000.ts'));
    expect(segment.status).toBe(200);
    expect(await segment.text()).toBe('TS');

    expect(reads).toEqual([
      `get public/variants/${dir}/hls_360p.m3u8`,
      `get public/variants/${dir}/segment_360p_000.ts`,
    ]);
    // One cached copy, under the canonical path.
    expect([...entries.keys()]).toEqual([
      `https://cloud.oxy.so/variants/${dir}/hls_360p.m3u8`,
      `https://cloud.oxy.so/variants/${dir}/segment_360p_000.ts`,
    ]);
  });

  it('leaves the canonical paths and every other shape alone', async () => {
    expect(canonicalRenditionPath(`/variants/${dir}/hls_360p.m3u8`)).toBeNull();
    // The two directories must be the same one.
    expect(
      canonicalRenditionPath(`/variants/${dir}/public/variants/2026/07/1f/other/hls_360p.m3u8`),
    ).toBeNull();
    // One name, never a path below the directory.
    expect(canonicalRenditionPath(`${doubled('x')}/y.ts`)).toBeNull();
    expect(canonicalRenditionPath(doubled(''))).toBeNull();
    // Only under /variants/, and only once.
    expect(canonicalRenditionPath(`/content/${dir}/public/variants/${dir}/a.ts`)).toBeNull();
    expect(
      canonicalRenditionPath(`/variants/a/public/variants/a/public/variants/a/x.ts`),
    ).toBeNull();

    const { get } = harness(objects);
    expect((await get(`/variants/${dir}/hls_360p.m3u8`)).headers.get('link')).toBeNull();
    // A doubled path to an object that does not exist is still a 404.
    expect((await get(doubled('hls_9999p.m3u8'))).status).toBe(404);
  });
});
