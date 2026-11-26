/**
 * The person's files (`@oxy.so/bloom-data`), held in the store of the account
 * that reads them, in memory only (the SDK never wrote its file reads to disk).
 *
 * - `UserFile`: each file by id; `UserFiles` orders a library or a trash, per
 *   owner, filled page by page by `userFiles`.
 * - `FileAppAccess`: the applications that can open one file (ADR 0043 stage
 *   4c), read by `fileAppAccess` and changed by `revokeFileAppAccess`.
 * - `uploadFile`: puts a file in the person's library.
 * - `FileUrl`: signed thumbnail URLs, read a page at a time by `fileUrls`.
 * - `PhotoSize`, `ImageSize` and `AvatarCropSource`: image measurements and the
 *   URL the avatar cropper loads.
 *
 * Signed URLs expire, and measurements follow them, so none of these is ever
 * written to disk: a restored one would serve an expired URL.
 */
import { action, entity, list, source } from '@oxy.so/bloom-data';
import type {
  AssetMetadata,
  AssetUploadInput,
  FileApplicationAccess,
  FileMetadata,
  OxyServices,
} from '@oxy.so/core';
import { authenticatedApiCall, type FileApplicationAccessRevocation } from '@oxy.so/core';
import { getImageSize } from '../utils/imageSize';
import { sdkRead } from './readOptions';

// ── The library and the trash ─────────────────────────────────────────────

/** Files read per page. */
export const FILES_PAGE_SIZE = 40;

/** Raw file record as returned by `oxyServices.assets.list` / `assetUpload`. */
export interface RawUserFile {
  id: string;
  originalName?: string;
  sha256?: string;
  mime?: string;
  size?: number;
  createdAt?: string;
  metadata?: Record<string, unknown>;
  variants?: unknown[];
  /** Whether any application uses the file (ADR 0043 D5). */
  inUse?: boolean;
  /** `blocked`: taken down after a content claim (ADR 0043 D10). */
  status?: string;
  /** When the owner moved it to trash (ADR 0043 D5). */
  trashedAt?: string | null;
}

/** One page of a file listing. */
export interface UserFilesPage {
  files: FileMetadata[];
  total: number;
  hasMore: boolean;
  nextOffset: number;
}

/** Normalize a raw API file record into the client `FileMetadata` shape. */
export function mapRawFileToMetadata(raw: RawUserFile): FileMetadata {
  return {
    id: raw.id,
    filename: raw.originalName ?? raw.sha256 ?? '',
    contentType: raw.mime ?? '',
    length: raw.size ?? 0,
    chunkSize: 0,
    uploadDate: raw.createdAt ?? '',
    ...(typeof raw.inUse === 'boolean' ? { inUse: raw.inUse } : {}),
    ...(raw.status === 'active' ||
    raw.status === 'trash' ||
    raw.status === 'blocked' ||
    raw.status === 'lost'
      ? { status: raw.status }
      : {}),
    ...(typeof raw.trashedAt === 'string' ? { trashedAt: raw.trashedAt } : {}),
    metadata: raw.metadata ?? {},
    variants: (raw.variants ?? []) as FileMetadata['variants'],
  };
}

/** Which of the owner's files a listing holds: the library, or the trash (ADR 0043 D5). */
export type UserFilesListing = 'library' | 'trash';

/** Map one `oxyServices.assets.list` response onto a page. */
export function toUserFilesPage(
  response: { files?: unknown[]; total?: number; hasMore?: boolean },
  offset: number,
): UserFilesPage {
  const files = ((response.files ?? []) as RawUserFile[]).map(mapRawFileToMetadata);
  return {
    files,
    total: response.total ?? offset + files.length,
    hasMore: Boolean(response.hasMore),
    nextOffset: offset + FILES_PAGE_SIZE,
  };
}

export const UserFile = entity<FileMetadata>('userFile', { id: (file) => file.id });

/** The files of one owner's library or trash, in the server's order. */
export const UserFiles = list('userFiles', { of: UserFile });

/** The `UserFiles` key of an owner's listing. */
export function userFilesKey(ownerId: string, listing: UserFilesListing): string {
  return `${listing}:${ownerId}`;
}

/**
 * An owner's library (active files, and blocked ones shown as removed after a
 * claim) or, with `trash`, what they moved to trash, most recently trashed
 * first. Read again every time a screen opens it (`stale: 0`); the next page
 * starts at the offset the last one named.
 */
export const userFiles = source(UserFiles, {
  key: (_oxy: OxyServices, ownerId: string, listing: UserFilesListing) =>
    userFilesKey(ownerId, listing),
  load: async ({ cursor }, oxy, _ownerId, listing) => {
    const offset = cursor === undefined ? 0 : Number(cursor);
    const page = toUserFilesPage(
      await oxy.assets.list({
        limit: FILES_PAGE_SIZE,
        offset,
        ...(listing === 'trash' ? { status: 'trash' as const } : {}),
      }),
      offset,
    );
    return { items: page.files, next: page.hasMore ? String(page.nextOffset) : null };
  },
  stale: 0,
  ...sdkRead,
});

/**
 * Puts a file (an upload still in flight) at the top of the owner's library,
 * when the library has been read.
 */
export function prependUserFile(ownerId: string, file: FileMetadata): void {
  UserFile.put(file);
  UserFiles.prepend(userFilesKey(ownerId, 'library'), [file.id]);
}

/** Takes a file out of the owner's library, or out of the trash. */
export function removeUserFile(
  ownerId: string,
  fileId: string,
  listing: UserFilesListing = 'library',
): void {
  UserFiles.set(userFilesKey(ownerId, listing), (held) =>
    held?.ids.includes(fileId) ? { ...held, ids: held.ids.filter((id) => id !== fileId) } : held,
  );
}

/** Swaps an upload in flight (by its temporary id) for the file the server stored. */
export function replaceUserFile(ownerId: string, temporaryId: string, file: FileMetadata): void {
  UserFile.put(file);
  UserFiles.set(userFilesKey(ownerId, 'library'), (held) =>
    held?.ids.includes(temporaryId)
      ? { ...held, ids: held.ids.map((id) => (id === temporaryId ? file.id : id)) }
      : held,
  );
}

/** Merges a metadata change (a new visibility, say) into a held file. */
export function patchUserFileMetadata(fileId: string, metadata: Record<string, unknown>): void {
  UserFile.merge(fileId, { metadata } as Partial<FileMetadata>);
}

/**
 * Reads the owner's listings again: the library, or both the library and the
 * trash after a change that moves a file between them. A listing no screen
 * has read is left alone; it is read when one opens it.
 */
export function refreshUserFiles(
  oxy: OxyServices,
  ownerId: string,
  listings: readonly UserFilesListing[] = ['library', 'trash'],
): void {
  for (const listing of listings) {
    if (UserFiles.get(userFilesKey(ownerId, listing))) {
      void userFiles.refresh(oxy, ownerId, listing);
    }
  }
}

// ── Applications with access (ADR 0043 stage 4c) ─────────────────────────

/** The applications that can open one of the owner's files. */
export interface FileAppAccessRecord {
  id: string;
  apps: FileApplicationAccess[];
}

export const FileAppAccess = entity<FileAppAccessRecord>('fileAppAccess', {
  id: (access) => access.id,
});

/**
 * The applications that can open one of the owner's files with their own
 * token: one that stored it for the person, or one the person attached it to.
 * Read every time the details open (`stale: 0`), since an application can gain
 * access at any time (a new upload on the person's behalf).
 */
export const fileAppAccess = source(FileAppAccess, {
  key: (_oxy: OxyServices, fileId: string) => fileId,
  load: async (_request, oxy, fileId) => ({
    id: fileId,
    apps: await oxy.assets.listAppAccess(fileId),
  }),
  stale: 0,
  ...sdkRead,
});

/**
 * Takes an application's access to one of the person's files away: the
 * application leaves the list at once and comes back if the revoke fails.
 * The caller reads the list again either way.
 */
export const revokeFileAppAccess = action({
  optimistic: (
    _oxy: OxyServices,
    _sessionId: string | null,
    fileId: string,
    applicationId: string,
  ) => {
    FileAppAccess.patch(fileId, (held) => ({
      apps: held.apps.filter((app) => app.applicationId !== applicationId),
    }));
  },
  run: (oxy: OxyServices, sessionId: string | null, fileId: string, applicationId: string) =>
    authenticatedApiCall<FileApplicationAccessRevocation>(oxy, sessionId, () =>
      oxy.assets.revokeAppAccess(fileId, applicationId),
    ),
});

// ── Signed thumbnail URLs ─────────────────────────────────────────────────

// ── Uploads ────────────────────────────────────────────────────────────

/** What an upload answers: one file, or a batch. */
export interface UploadResult {
  file?: UploadedFile;
  files?: UploadedFile[];
  id?: string;
}

export interface UploadedFile {
  id: string;
  originalName?: string;
  sha256?: string;
  mime?: string;
  size?: number;
  createdAt?: string;
  metadata?: Record<string, unknown>;
  variants?: Array<{
    type: string;
    key: string;
    width?: number;
    height?: number;
    readyAt?: string;
    metadata?: Record<string, unknown>;
  }>;
}

export interface UploadFileInput {
  file: AssetUploadInput;
  visibility?: 'private' | 'public' | 'unlisted';
  metadata?: AssetMetadata;
  onProgress?: (progress: number) => void;
}

/** Uploads a file to the person's library. */
export const uploadFile = action({
  run: (oxy: OxyServices, sessionId: string | null, input: UploadFileInput) =>
    authenticatedApiCall<UploadResult>(oxy, sessionId, () =>
      oxy.assets.upload(input.file, {
        visibility: input.visibility,
        metadata: input.metadata,
        onProgress: input.onProgress,
      }),
    ),
});

/**
 * The variant-aware batch resolver contract (`@oxy.so/core`).
 *
 * `urls` takes a per-file `{ fileId, variant }` list and returns a map keyed
 * by `fileId`; ids that are denied or missing are OMITTED (never an empty
 * string), and PRIVATE assets resolve to a working scoped-media-token stream
 * URL. Typed here rather than `Pick<OxyServices, …>` so this file states the
 * exact contract it depends on.
 */
export interface AssetUrlBatchResolver {
  assets: {
    urls(
      requests: Array<{ fileId: string; variant?: string }>,
      options?: { expiresIn?: number; context?: string },
    ): Promise<Record<string, string>>;
  };
}

/** One file's resolved URL for one variant. */
export interface FileUrlRecord {
  /** `fileUrlId(fileId, variant)`. */
  id: string;
  url: string;
}

export function fileUrlId(fileId: string, variant: string | undefined): string {
  return `${fileId}:${variant ?? ''}`;
}

export const FileUrl = entity<FileUrlRecord>('fileUrl', { id: (entry) => entry.id });

/** The URLs one batch of files resolved to. */
export const FileUrlBatches = list('fileUrlBatches', { of: FileUrl });

/** Server media-token lifetime asked for each resolved URL (seconds). */
const ASSET_URL_TTL_SECONDS = 600; // 10 minutes
/** Server-side batch cap for `POST /assets/batch-access`: chunk beyond this. */
const BATCH_CAP = 100;

/** The `fileUrls` key of a request set: its content, sorted, so ordering churn reads nothing again. */
export function fileUrlsKey(requests: ReadonlyArray<{ fileId: string; variant?: string }>): string {
  return requests
    .map((request) => fileUrlId(request.fileId, request.variant))
    .sort()
    .join('|');
}

/**
 * Resolves a set of files' thumbnail URLs in one (chunked) batch request.
 * Read again after 5 minutes, below the token's 10-minute lifetime, so a tile
 * never shows a URL whose token has expired.
 */
export const fileUrls = source(FileUrlBatches, {
  key: (
    _oxy: AssetUrlBatchResolver,
    requests: ReadonlyArray<{ fileId: string; variant?: string }>,
  ) => fileUrlsKey(requests),
  load: async (_request, oxy, requests) => {
    const items: FileUrlRecord[] = [];
    for (let i = 0; i < requests.length; i += BATCH_CAP) {
      const chunk = requests.slice(i, i + BATCH_CAP);
      const urls = await oxy.assets.urls([...chunk], { expiresIn: ASSET_URL_TTL_SECONDS });
      for (const request of chunk) {
        const url = urls[request.fileId];
        if (typeof url === 'string' && url.length > 0) {
          items.push({ id: fileUrlId(request.fileId, request.variant), url });
        }
      }
    }
    return { items };
  },
  stale: 5 * 60_000,
  gcTime: 30 * 60_000,
  ...sdkRead,
});

// ── Image measurements ────────────────────────────────────────────────────

/** A photo's intrinsic size, by file id. */
export interface PhotoSizeRecord {
  id: string;
  width: number;
  height: number;
}

export const PhotoSize = entity<PhotoSizeRecord>('photoSize', { id: (size) => size.id });

/** The sizes one set of photo URLs measured. */
export const PhotoSizeBatches = list('photoSizeBatches', { of: PhotoSize });

/** A photo to measure: its file id and its resolved URL. */
export interface PhotoToMeasure {
  id: string;
  url: string;
}

/**
 * Measures every photo whose URL has resolved (`getImageSize`, expo-image on a
 * device). A photo that fails to load measures 1×1 (the 4/3 default). Keyed by
 * every photo id with its URL, so a URL that resolves later is measured then;
 * a measurement never goes stale.
 */
export const photoSizes = source(PhotoSizeBatches, {
  key: (photos: readonly PhotoToMeasure[]) =>
    photos.map((photo) => `${photo.id}:${photo.url}`).join('|'),
  load: async (_request, photos) => ({
    items: await Promise.all(
      photos.map(async (photo): Promise<PhotoSizeRecord> => {
        try {
          return { id: photo.id, ...(await getImageSize(photo.url)) };
        } catch {
          return { id: photo.id, width: 1, height: 1 };
        }
      }),
    ),
  }),
  stale: Number.POSITIVE_INFINITY,
  ...sdkRead,
});

/** An image's intrinsic size, by its URI. */
export interface ImageSizeRecord {
  id: string;
  width: number;
  height: number;
}

export const ImageSize = entity<ImageSizeRecord>('imageSize', { id: (size) => size.id });

/**
 * The intrinsic size of the image at `uri`. Fails (no retry) on a load error
 * or degenerate dimensions, so the cropper can say it could not measure it.
 */
export const imageSize = source(ImageSize, {
  key: (uri: string) => uri,
  load: async (_request, uri) => {
    let size: { width: number; height: number };
    try {
      size = await getImageSize(uri);
    } catch {
      throw new Error('Image measurement failed');
    }
    const { width, height } = size;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error('Image reported invalid dimensions');
    }
    return { id: uri, width, height };
  },
  stale: Number.POSITIVE_INFINITY,
  retry: 0,
  refetchOnFocus: false,
});

/** The URL the avatar cropper loads for one of the person's files. */
export interface AvatarCropSourceRecord {
  id: string;
  url: string;
}

export const AvatarCropSource = entity<AvatarCropSourceRecord>('avatarCropSource', {
  id: (entry) => entry.id,
});

/**
 * Resolves a file id to a URL the cropper can load (usually private, so
 * through the SDK). Fails at once (no retry) when no URL comes back.
 */
export const avatarCropSource = source(AvatarCropSource, {
  key: (_oxy: OxyServices, fileId: string) => fileId,
  load: async (_request, oxy, fileId) => {
    const url = await oxy.assets.url(fileId);
    if (!url) throw new Error('No download URL returned for the selected image');
    return { id: fileId, url };
  },
  stale: Number.POSITIVE_INFINITY,
  retry: 0,
  refetchOnFocus: false,
});
