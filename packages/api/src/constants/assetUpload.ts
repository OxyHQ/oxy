/**
 * The largest file `POST /assets/upload` and `POST /assets/:id/upload-direct`
 * accept in one multipart request, in bytes.
 *
 * api.oxy.so is served through a proxy that refuses any request body over
 * 100 MB (10^8 bytes) with a 413 of its own — an HTML page, before Oxy sees
 * the request. Refusing the file here first, below that cap with room for the
 * multipart envelope and its fields, gives a client Oxy's own JSON answer
 * instead, naming the way through: {@link USE_PRESIGNED_UPLOAD}.
 *
 * `@oxy.so/core`'s `assets.upload` sends nothing over 64 MiB this way (its
 * `ASSET_MULTIPART_UPLOAD_MAX_BYTES`): a larger file is hashed, `/assets/init`
 * presigns a PUT straight to storage, and `/assets/complete` commits it. This
 * cap must stay above that one, or a current client's file is refused.
 */
export const ASSET_MULTIPART_FILE_MAX_BYTES = 90 * 1024 * 1024;

/**
 * The 413 code of a multipart file over {@link ASSET_MULTIPART_FILE_MAX_BYTES}:
 * upload it by presigned PUT (`POST /assets/init`, PUT, `POST /assets/complete`).
 */
export const USE_PRESIGNED_UPLOAD = 'USE_PRESIGNED_UPLOAD';
