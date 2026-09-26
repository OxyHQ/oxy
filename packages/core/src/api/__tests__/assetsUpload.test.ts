/**
 * `oxy.assets.upload()` multipart-body tests.
 *
 * `assets.upload` accepts three input shapes: a web `File`, a web `Blob`, or a
 * React Native `{ uri, type?, name?, size? }` descriptor. The descriptor path
 * is platform-sensitive:
 *
 *   - React Native — RN's FormData reads the file from disk via the uri during
 *     the multipart request, so the descriptor is appended as-is.
 *   - Web (browser/Node) — the browser's FormData CANNOT read bytes from a plain
 *     `{ uri }` object (it would serialize `[object Object]` → the server stores
 *     a 0-byte asset). The uri must be materialized into a real `Blob` via
 *     `fetch` before appending. An empty fetched blob must throw instead of
 *     silently uploading an empty asset.
 *
 * These tests assert exactly which value lands in the FormData `file` part for
 * each platform, and that an empty web source is rejected.
 */

import { OxyServices } from '../../OxyServices';

/**
 * Captures every `FormData.append` call so a test can inspect the multipart body
 * that `assets.upload` built without sending a real network request.
 */
function captureUpload(oxy: OxyServices) {
  const appended: Array<{ name: string; value: unknown; fileName?: string }> = [];
  // Capture-only: do NOT delegate to the real (undici) FormData.append. Node's
  // undici rejects a plain { uri } object as not-a-Blob, but real React Native
  // FormData accepts it — the test asserts on captured args, not a built body.
  const appendSpy = jest
    .spyOn(FormData.prototype, 'append')
    .mockImplementation(function (this: FormData, name: string, value: unknown, fileName?: string) {
      appended.push({ name, value, fileName });
    });

  const requestSpy = jest
    .spyOn(oxy.http, 'request')
    .mockResolvedValue({ file: { id: 'asset123' } } as never);

  return {
    appended,
    requestSpy,
    restore: () => {
      appendSpy.mockRestore();
      requestSpy.mockRestore();
    },
  };
}

describe('oxy.assets.upload — uri descriptor', () => {
  const originalNavigator = (globalThis as { navigator?: unknown }).navigator;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalNavigator === undefined) {
      Reflect.deleteProperty(globalThis, 'navigator');
    } else {
      (globalThis as { navigator?: unknown }).navigator = originalNavigator;
    }
    globalThis.fetch = originalFetch;
  });

  describe('web (NOT React Native)', () => {
    beforeEach(() => {
      // Node/jsdom-like: no React Native navigator → isReactNative() === false.
      Reflect.deleteProperty(globalThis, 'navigator');
    });

    it('materializes a blob: uri into a real, non-empty Blob before appending', async () => {
      const bytes = new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/png' });
      const fetchMock = jest
        .fn()
        .mockResolvedValue({ ok: true, status: 200, blob: async () => bytes });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
      const capture = captureUpload(oxy);

      try {
        await oxy.assets.upload({ uri: 'blob:https://app.test/abc', type: 'image/png', name: 'avatar.png' });

        expect(fetchMock).toHaveBeenCalledWith('blob:https://app.test/abc');

        const filePart = capture.appended.find((p) => p.name === 'file');
        expect(filePart).toBeDefined();
        // The appended value is the fetched Blob with real bytes — NOT the { uri } object.
        expect(filePart?.value).toBeInstanceOf(Blob);
        expect((filePart?.value as Blob).size).toBe(5);
        expect((filePart?.value as { uri?: string }).uri).toBeUndefined();
        expect(filePart?.fileName).toBe('avatar.png');
      } finally {
        capture.restore();
      }
    });

    it('wraps a typeless fetched blob with the descriptor MIME type', async () => {
      const typeless = new Blob([new Uint8Array([9, 9, 9])]); // type === ''
      const fetchMock = jest
        .fn()
        .mockResolvedValue({ ok: true, status: 200, blob: async () => typeless });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
      const capture = captureUpload(oxy);

      try {
        await oxy.assets.upload({ uri: 'data:application/octet-stream;base64,CQkJ', type: 'image/jpeg', name: 'x.jpg' });

        const filePart = capture.appended.find((p) => p.name === 'file');
        expect(filePart?.value).toBeInstanceOf(Blob);
        expect((filePart?.value as Blob).size).toBe(3);
        expect((filePart?.value as Blob).type).toBe('image/jpeg');
      } finally {
        capture.restore();
      }
    });

    it('throws "Cannot upload an empty file" when the fetched blob is empty', async () => {
      const empty = new Blob([], { type: 'image/png' });
      const fetchMock = jest
        .fn()
        .mockResolvedValue({ ok: true, status: 200, blob: async () => empty });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
      const capture = captureUpload(oxy);

      try {
        await expect(
          oxy.assets.upload({ uri: 'blob:https://app.test/empty', type: 'image/png', name: 'empty.png' }),
        ).rejects.toThrow('Cannot upload an empty file');

        // Nothing was sent — the empty source surfaces instead of creating a 0-byte asset.
        expect(capture.requestSpy).not.toHaveBeenCalled();
      } finally {
        capture.restore();
      }
    });

    it('throws when the uri cannot be fetched (non-ok response)', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValue({ ok: false, status: 404, blob: async () => new Blob([]) });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
      const capture = captureUpload(oxy);

      try {
        await expect(
          oxy.assets.upload({ uri: 'https://cdn.test/missing.png', type: 'image/png', name: 'missing.png' }),
        ).rejects.toThrow('Failed to read file from uri (status 404)');
        expect(capture.requestSpy).not.toHaveBeenCalled();
      } finally {
        capture.restore();
      }
    });
  });

  describe('React Native', () => {
    beforeEach(() => {
      // Make isReactNative() === true: navigator.product === 'ReactNative'.
      (globalThis as { navigator?: unknown }).navigator = { product: 'ReactNative' };
    });

    it('appends the descriptor as-is and never calls fetch', async () => {
      const fetchMock = jest.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });
      const capture = captureUpload(oxy);

      const descriptor = { uri: 'file:///tmp/avatar.png', type: 'image/png', name: 'avatar.png', size: 1024 };

      try {
        await oxy.assets.upload(descriptor);

        // RN path: the raw descriptor object lands in the multipart body unchanged.
        const filePart = capture.appended.find((p) => p.name === 'file');
        expect(filePart?.value).toBe(descriptor);
        expect(filePart?.fileName).toBe('avatar.png');
        // No in-JS materialization on RN — FormData reads the file from the uri.
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        capture.restore();
      }
    });
  });
});
