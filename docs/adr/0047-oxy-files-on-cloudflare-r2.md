# 0047 — Oxy Files on Cloudflare R2

Status: accepted by Nate on 2026-10-21 (Cloudflare for Startups credits on "The
Oxy Collective, Inc."; R2 capped at USD 10k a year). Procedure and evidence:
oxy-infra `docs/runbooks/61-r2-object-storage.md`.

## Context

Oxy Files' S3 bucket (`oxy-oxy-api-media-usw2-…`) held 2.50 TB in 10.9 M objects
on 2026-10-21, growing ~300–350 GB of originals and 200–400 GB of renditions a
month, all of it read out through CloudFront (`cloud.oxy.so`). Storage, egress
and CloudFront requests are the cost; R2 charges no egress. Syra's own bucket
(126 GB, 0.8 M objects) has the same shape. Homiio's legacy bucket is already
in Oxy Files and is not moved.

## Decision

1. **The store is R2.** Buckets `oxy-files` (Oxy Files), `syra-media` (Syra's
   originals and ladders) and `oxy-website-legacy-media` (the website's
   pre-Oxy-Files images, `public/oxy-website/…`, which the website still deletes
   itself), location hint `wnam`. Cloudflare is not in Terraform, so the buckets,
   their CORS, tokens and migration jobs are created through the Cloudflare API
   exactly as the runbook records.
2. **Credentials** are R2 API tokens scoped to ONE bucket (Object Read & Write),
   kept in SSM as `/oxy/<app>/R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`. The
   store is configured with `R2_ENDPOINT` and `R2_BUCKET` — never
   `AWS_ENDPOINT_URL` / `AWS_ACCESS_KEY_ID`, which every AWS SDK client in the
   process reads (SES, STS attestation, CloudFront).
3. **Migration without downtime: Sippy plus Super Slurper**, chosen over
   app-level dual reads because both the API and the CDN Worker then read one
   store, and R2 falls through to S3 for whatever is not copied yet. Measured
   behaviour that the code is built around:
   - Sippy copies on GET (S3 API, presigned URL, Worker binding) and keeps
     Content-Type, Cache-Control, Content-Disposition and user metadata; a HEAD
     falls through without copying; **a CopyObject whose source is only in S3
     is NoSuchKey**; a delete in R2 leaves the S3 copy, which the next GET
     copies back.
   - Super Slurper keeps bytes (sha256 equal) but **drops Content-Type and
     Cache-Control on objects it copies in parts** (a 220 MB object: none), so
     verification repairs them from S3.
   So while S3 is the legacy store, the API repeats every delete there, lists
   both, and brings a copy's source over from S3 first
   (`services/s3Service.ts`). After the copy is verified — counts, sizes and
   single-part ETags for every key, sha256 for a sample against the
   content-addressed key and `files.sha256` — Sippy is disabled, `AWS_S3_BUCKET`
   leaves the task definitions and the S3 path leaves the code.
4. **Presigned PUTs sign `x-amz-checksum-sha256` as a header** and return it in
   `requiredHeaders`. Measured on R2: the query-string form is ignored (bytes
   that do not hash to it are stored); the signed header is enforced (400
   `BadDigest`). S3 behaves the same with the header. The SDK's default CRC32
   is off (`WHEN_REQUIRED`): it put the CRC of an EMPTY body in every presigned
   URL. The `oxy-files` bucket allows GET/HEAD/PUT from any origin: the
   signature is the credential, so an origin list would protect nothing (the S3
   bucket had no CORS at all, so browser `uploadLarge` never worked on it).
5. **`cloud.oxy.so` is a Cloudflare Worker** (`workers/cloud`) with the same
   URL shapes and semantics as the CloudFront behaviors it replaces: object
   paths are read ONLY under `public/` (a private file's key cannot be named),
   the immutable year for content-addressed media, the playlist's own
   Cache-Control, the download disposition and sandbox CSP, CORS `*` on every
   response, and `/<fileId>?variant=` resolved by oxy-api's `GET /cdn/:id`.
   Objects up to 500 MB are kept in the Cache API, which answers ranges from
   the cached copy. A resolver 302 is kept in the Cache API with oxy-api's own
   Cache-Control (an hour): `fetch`'s edge cache would stamp the zone's
   four-hour Browser Cache TTL over it.
6. **Purge replaces invalidation.** A deleted public object's URL is purged by
   URL (`services/cdnPurge.ts`, 100 per request); a file id's resolver answers
   by the Cache-Tag `file:<id>` the Worker gives every variant. Both are
   measured to remove Cache API entries. The CloudFront queue runs beside it
   until the distribution is deleted.
7. **S3 stops being read or written** once the soak is verified. Deleting the
   buckets, the CloudFront distribution and the migration reader is a separate,
   explicitly approved step.

## Native file transport (core 7.7 / services 13.8)

`OxyProvider` installs the SDK's native asset-file adapter on iOS and Android.
Core remains platform-neutral: the adapter supplies metadata, bounded range
reads, and binary PUTs for the existing upload-session protocol. Web keeps its
Blob transport. The macOS provider does not import Expo FileSystem; native URI
uploads there need a host-provided adapter when their size is unknown or large. An unknown-size or large native URI without an
adapter fails before allocation; direct core consumers can install an
`AssetFileAdapter` explicitly. Known-small descriptors still use native FormData.

A native URI must never first become a whole-file Blob. React Native's Android
BlobModule allocates a Java byte array for the entire file; a physical Pixel 8a
failed a 369,812,592-byte camera video against a 268,435,456-byte Java heap. Expo
File.slice is not a substitute: it calls bytesSync for the whole source before
slicing. The adapter instead reads FileHandle chunks of at most 1 MiB, supplies
hash ranges of at most 8 MiB, copies only the current multipart ranges into
private cache files, and streams those files through native binary upload tasks.
No Oxy bearer or cookie is supplied to storage.

Each part is removed after success, failure, timeout or cancellation, and the
next JS runtime removes leftovers from terminated foreground transfers. The
original capture is never deleted by this transport. A failed parallel part
cancels and awaits its siblings before returning; reopening the same bytes still
resumes the authoritative server session. File-size changes are rejected before
hash/read or PUT; server verification detects changed content of equal size.
`assets.upload` reports `onStageProgress` for hash/upload/verify and accepts an
AbortSignal. Its original `onProgress(100)` completion callback remains compatible.
