import { runDirectUpload, type DirectUploadApi } from '../directUpload';
import type { AssetFileSource } from '../assetFileSource';

test('a failed native part cancels and awaits sibling cleanup before rejecting', async () => {
  const api: DirectUploadApi = {
    open: jest.fn(),
    partUrls: jest.fn(),
    complete: jest.fn(),
    describe: jest.fn(),
  };
  let cleaned = 0;
  const source: AssetFileSource = {
    size: 16,
    readRange: jest.fn(),
    async putPart({ start, signal }) {
      try {
        if (start === 0) {
          await Promise.resolve();
          throw new Error('Native part failed');
        }
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('Sibling stopped')), {
            once: true,
          });
        });
        return { ok: true };
      } finally {
        await Promise.resolve();
        cleaned++;
      }
    },
  };
  await expect(
    runDirectUpload(
      api,
      source,
      {
        uploadId: 'session',
        status: 'uploading',
        size: 16,
        partSize: 8,
        partCount: 2,
        parts: [
          { partNumber: 1, url: 'https://storage.example/1', size: 8 },
          { partNumber: 2, url: 'https://storage.example/2', size: 8 },
        ],
      },
      { partConcurrency: 2, partAttempts: 1 },
    ),
  ).rejects.toThrow('Native part failed');
  expect(cleaned).toBe(2);
  expect(api.complete).not.toHaveBeenCalled();
});
