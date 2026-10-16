/**
 * `OxyServer.assets.uploadAppFileLarge` / `uploadUserMediaLarge` (ADR 0042
 * stage 4b): the client half of the multipart upload, against a fake API
 * (`serviceRequest` stubbed) and a fake bucket (`fetch` stubbed).
 *
 * Pinned: the declared SHA-256 is the source's; every part is exactly its
 * slice; a resumed session sends only the missing parts; an expired part URL
 * is refreshed; `202 verifying` is polled to the end; the owner header rides
 * every call of a user-media upload; a failure ends in a typed error.
 */

import { createHash } from 'node:crypto';
import { OxyServer } from '../OxyServer';
import { LargeUploadFailedError } from '../largeUpload';

const PART = 4;

interface FakeState {
  status: 'uploading' | 'verifying' | 'completed' | 'failed';
  held: Map<number, Uint8Array>;
  polls: number;
  verifyPolls: number;
  failWith?: { code: string; message: string };
}

const file = { id: 'file-1', ownerApplicationId: 'app-1', status: 'active' };

function fakeApi(
  oxy: OxyServer,
  bytes: Uint8Array,
  options: {
    held?: number[];
    verifyPolls?: number;
    deduplicated?: boolean;
    failWith?: FakeState['failWith'];
  } = {},
) {
  const partCount = Math.ceil(bytes.length / PART);
  const state: FakeState = {
    status: 'uploading',
    held: new Map((options.held ?? []).map((n) => [n, bytes.slice((n - 1) * PART, n * PART)])),
    polls: 0,
    verifyPolls: options.verifyPolls ?? 0,
    failWith: options.failWith,
  };
  const url = (n: number, generation = 0) => `https://bucket.example/part?n=${n}&g=${generation}`;
  const view = () => ({
    uploadId: 'up-1',
    status: state.status,
    size: bytes.length,
    partSize: PART,
    partCount,
    ...(state.status === 'uploading'
      ? {
          uploadedParts: [...state.held.entries()].map(([partNumber, part]) => ({
            partNumber,
            size: part.length,
          })),
        }
      : {}),
    ...(state.status === 'completed' ? { file, deduplicated: false } : {}),
    ...(state.status === 'failed' ? { error: state.failWith } : {}),
  });
  const calls: { method: string; path: string; body: unknown; headers: unknown }[] = [];
  jest
    .spyOn(oxy, 'serviceRequest')
    .mockImplementation(
      async (
        method: string,
        path: string,
        body?: unknown,
        opts?: { headers?: Record<string, string> },
      ) => {
        calls.push({ method, path, body, headers: opts?.headers });
        if (method === 'POST' && /\/uploads$/.test(path)) {
          if (options.deduplicated) {
            return {
              uploadId: null,
              status: 'completed',
              size: bytes.length,
              file,
              deduplicated: true,
            };
          }
          const missing = [];
          for (let n = 1; n <= partCount; n++) if (!state.held.has(n)) missing.push(n);
          return {
            ...view(),
            parts: missing.map((n) => ({ partNumber: n, url: url(n), size: PART })),
          };
        }
        if (method === 'POST' && path.endsWith('/parts')) {
          const { partNumbers } = body as { partNumbers: number[] };
          return {
            ...view(),
            parts: partNumbers.map((n) => ({ partNumber: n, url: url(n, 1), size: PART })),
          };
        }
        if (method === 'POST' && path.endsWith('/complete')) {
          const assembled = Buffer.concat(
            [...state.held.entries()].sort(([a], [b]) => a - b).map(([, p]) => p),
          );
          if (!assembled.equals(Buffer.from(bytes)))
            throw Object.assign(new Error('incomplete'), { status: 409 });
          state.status =
            state.verifyPolls > 0 ? 'verifying' : state.failWith ? 'failed' : 'completed';
          return view();
        }
        if (method === 'GET') {
          state.polls++;
          if (state.status === 'verifying' && state.polls >= state.verifyPolls) {
            state.status = state.failWith ? 'failed' : 'completed';
          }
          return view();
        }
        throw new Error(`unexpected ${method} ${path}`);
      },
    );
  return { state, calls };
}

function fakeBucket(state: FakeState, options: { expireFirstUrl?: boolean } = {}) {
  const puts: string[] = [];
  global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(input));
    puts.push(target.toString());
    const n = Number(target.searchParams.get('n'));
    if (options.expireFirstUrl && target.searchParams.get('g') === '0' && n === 1) {
      return new Response(null, { status: 403 });
    }
    const body = new Uint8Array(await (init?.body as Blob).arrayBuffer());
    state.held.set(n, body);
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return puts;
}

const bytes = new Uint8Array(Array.from({ length: 10 }, (_, i) => i + 1));
const sha = createHash('sha256').update(bytes).digest('hex');

describe('OxyServer.assets large uploads', () => {
  let oxy: OxyServer;
  const realFetch = global.fetch;

  beforeEach(() => {
    oxy = new OxyServer({ baseURL: 'http://test.invalid' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = realFetch;
  });

  it('declares the source’s hash, PUTs every part as its slice, and returns the file', async () => {
    const { state, calls } = fakeApi(oxy, bytes);
    const puts = fakeBucket(state);
    const progress: string[] = [];

    const result = await oxy.assets.uploadAppFileLarge(new Blob([bytes]), {
      mime: 'application/zip',
      visibility: 'private',
      filename: 'a.zip',
      onProgress: (event) => progress.push(event.phase),
    });

    expect(result).toEqual({ file, deduplicated: false, uploadId: 'up-1' });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/assets/service/app/uploads',
      body: {
        sha256: sha,
        size: 10,
        mime: 'application/zip',
        visibility: 'private',
        filename: 'a.zip',
      },
    });
    expect(puts).toHaveLength(3);
    expect(progress).toContain('hash');
    expect(progress).toContain('upload');
  });

  it('resumes: sends only the parts the session lacks', async () => {
    const { state } = fakeApi(oxy, bytes, { held: [1, 3] });
    const puts = fakeBucket(state);

    await oxy.assets.uploadAppFileLarge(bytes, { mime: 'application/zip', visibility: 'private' });

    expect(puts.map((url) => new URL(url).searchParams.get('n'))).toEqual(['2']);
  });

  it('refreshes an expired part URL and retries the part', async () => {
    const { state, calls } = fakeApi(oxy, bytes);
    fakeBucket(state, { expireFirstUrl: true });

    await oxy.assets.uploadAppFileLarge(bytes, {
      mime: 'application/zip',
      visibility: 'private',
      partConcurrency: 1,
    });

    expect(calls.some((call) => call.path.endsWith('/parts'))).toBe(true);
  });

  it('polls a verifying upload to completion', async () => {
    const { state, calls } = fakeApi(oxy, bytes, { verifyPolls: 2 });
    fakeBucket(state);
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      const pending = oxy.assets.uploadAppFileLarge(bytes, {
        mime: 'application/zip',
        visibility: 'private',
      });
      for (let i = 0; i < 20 && state.status !== 'completed'; i++) {
        await jest.advanceTimersByTimeAsync(2_000);
      }
      await expect(pending).resolves.toMatchObject({ file });
    } finally {
      jest.useRealTimers();
    }
    expect(calls.filter((call) => call.method === 'GET').length).toBeGreaterThanOrEqual(2);
  });

  it('sends nothing for bytes the application already owns', async () => {
    const { state } = fakeApi(oxy, bytes, { deduplicated: true });
    const puts = fakeBucket(state);
    await expect(
      oxy.assets.uploadAppFileLarge(bytes, {
        mime: 'application/zip',
        visibility: 'public',
        sha256: sha,
      }),
    ).resolves.toMatchObject({ deduplicated: true, uploadId: null });
    expect(puts).toHaveLength(0);
  });

  it('carries the owner on every call of a user-media upload', async () => {
    const { state, calls } = fakeApi(oxy, bytes);
    fakeBucket(state);
    await oxy.assets.uploadUserMediaLarge('user-9', bytes, { mime: 'application/pdf' });
    expect(calls.every((call) => call.path.startsWith('/assets/service/user-media/uploads'))).toBe(
      true,
    );
    expect(
      calls.every(
        (call) => (call.headers as Record<string, string>)['x-owner-user-id'] === 'user-9',
      ),
    ).toBe(true);
  });

  it('ends a failed verification with LargeUploadFailedError', async () => {
    const { state } = fakeApi(oxy, bytes, {
      verifyPolls: 1,
      failWith: { code: 'CONTENT_BLOCKED', message: 'blocked' },
    });
    fakeBucket(state);
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      const pending = oxy.assets.uploadAppFileLarge(bytes, {
        mime: 'application/zip',
        visibility: 'private',
      });
      const assertion = expect(pending).rejects.toMatchObject({
        code: 'CONTENT_BLOCKED',
        uploadId: 'up-1',
      });
      await jest.advanceTimersByTimeAsync(5_000);
      await assertion;
      await expect(pending).rejects.toBeInstanceOf(LargeUploadFailedError);
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses a part URL that is not https', async () => {
    const { state } = fakeApi(oxy, bytes);
    fakeBucket(state);
    (oxy.serviceRequest as jest.Mock).mockImplementationOnce(async () => ({
      uploadId: 'up-1',
      status: 'uploading',
      size: 10,
      partSize: PART,
      partCount: 3,
      parts: [{ partNumber: 1, url: 'http://bucket.example/p', size: PART }],
    }));
    await expect(
      oxy.assets.uploadAppFileLarge(bytes, {
        mime: 'application/zip',
        visibility: 'private',
        partAttempts: 1,
      }),
    ).rejects.toThrow(/HTTPS/);
  });
});
