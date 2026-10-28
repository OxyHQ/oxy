import type { AssetFilePartRequest, AssetFileSource, OxyServices } from '@oxy.so/core';
import type { Directory, File } from 'expo-file-system';

// File.slice() reads the WHOLE file on Expo; RN Blob does the same on Java's
// heap. FileHandle reads and native file uploads keep both heaps bounded.
const COPY_CHUNK_BYTES = 1024 * 1024;
let partsDirectory: Promise<Directory> | undefined;
let nextPart = 0;

// FileHandle methods are synchronous: awaiting them alone only yields a
// microtask. Let rendering, native events and abort timers run between chunks.
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function abortError(): Error {
  const error = new Error('Upload aborted');
  error.name = 'AbortError';
  return error;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

async function temporaryParts(): Promise<Directory> {
  partsDirectory ??= import('expo-file-system')
    .then(({ Directory, Paths }) => {
      const directory = new Directory(Paths.cache, 'oxy-upload-parts');
      // These are foreground transfers. A new JS runtime owns no previous parts;
      // remove leftovers from a killed process before creating any new part.
      if (directory.exists) directory.delete();
      directory.create({ intermediates: true });
      return directory;
    })
    .catch((error) => {
      partsDirectory = undefined;
      throw error;
    });
  return partsDirectory;
}

async function copyRange(
  file: File,
  target: File,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<void> {
  const reader = file.open();
  try {
    reader.offset = start;
    const writer = target.open();
    try {
      for (let offset = start; offset < end; ) {
        checkAbort(signal);
        const bytes = await reader.readBytes(Math.min(COPY_CHUNK_BYTES, end - offset));
        if (!bytes.length) throw new Error('File changed while preparing upload');
        await writer.writeBytes(bytes);
        offset += bytes.length;
        await yieldToEventLoop();
      }
    } finally {
      writer.close();
    }
  } finally {
    reader.close();
  }
}

async function putRange(
  file: File,
  request: AssetFilePartRequest,
): ReturnType<AssetFileSource['putPart']> {
  const [{ File }, legacy, directory] = await Promise.all([
    import('expo-file-system'),
    import('expo-file-system/legacy'),
    temporaryParts(),
  ]);
  checkAbort(request.signal);
  const part = new File(directory, `part-${++nextPart}`);
  part.create();
  try {
    await copyRange(file, part, request.start, request.end, request.signal);
    checkAbort(request.signal);
    const task = legacy.createUploadTask(
      request.url,
      part.uri,
      {
        httpMethod: 'PUT',
        uploadType: legacy.FileSystemUploadType.BINARY_CONTENT,
        sessionType: legacy.FileSystemSessionType.FOREGROUND,
        headers: {},
      },
      ({ totalBytesSent }) => request.onProgress(totalBytesSent),
    );
    let cancel: Promise<void> | undefined;
    let stop = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      stop = () => {
        cancel ??= task.cancelAsync();
        void cancel.catch(() => undefined);
        reject(abortError());
      };
    });
    const timer = setTimeout(() => {
      stop();
    }, request.timeoutMs);
    request.signal?.addEventListener('abort', stop, { once: true });
    try {
      checkAbort(request.signal);
      const result = await Promise.race([task.uploadAsync(), interrupted]);
      if (!result) throw abortError();
      return result.status >= 200 && result.status < 300
        ? { ok: true }
        : { ok: false, status: result.status };
    } catch {
      if (request.signal?.aborted) throw abortError();
      // The core session owner applies its bounded retry/backoff policy.
      return { ok: false, status: 0 };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', stop);
      if (cancel) await cancel.catch(() => undefined);
    }
  } finally {
    if (part.exists) part.delete();
  }
}

async function openNativeFile(uri: string): Promise<AssetFileSource> {
  const { File } = await import('expo-file-system');
  const file = new File(uri);
  if (!file.exists) throw new Error('Native upload file is unavailable');
  const size = file.size;
  return {
    size,
    async readRange(start, end) {
      if (file.size !== size) throw new Error('File changed while uploading');
      if (start < 0 || end > size || end < start) throw new Error('Invalid upload file range');
      const reader = file.open();
      try {
        reader.offset = start;
        const output = new Uint8Array(end - start);
        let read = 0;
        while (read < output.length) {
          const bytes = await reader.readBytes(Math.min(COPY_CHUNK_BYTES, output.length - read));
          if (!bytes.length) throw new Error('File changed while hashing');
          output.set(bytes, read);
          read += bytes.length;
          await yieldToEventLoop();
        }
        return output;
      } finally {
        reader.close();
      }
    },
    putPart: (request) => {
      if (file.size !== size) throw new Error('File changed while uploading');
      return putRange(file, request);
    },
  };
}

/** One provider-owned adapter; no native filesystem module loads before an upload. */
export function installNativeAssetFiles(oxy: OxyServices): () => void {
  return oxy.assets.installFileAdapter(openNativeFile);
}
