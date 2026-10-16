/**
 * `/assets/recording-ingest` — the S3-compatible endpoint a recording target's
 * credentials point at (ADR 0043 stage 4c). A LiveKit egress, configured with
 * the target's `livekit.s3` (endpoint, bucket, `force_path_style`, access key
 * and secret), uploads its file here exactly as it would to S3: the AWS SDK's
 * upload manager sends `PutObject` for a small file and the multipart calls for
 * a large one, path-style (`/<bucket>/<key>`), signed with SigV4.
 *
 * Only what an uploader needs is served — `PutObject`, `CreateMultipartUpload`,
 * `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload` — and only
 * under the target's own prefix (`<targetId>/`): one recording, plus small side
 * objects (an egress's JSON manifest) that are discarded. Everything else is
 * `NotImplemented` or `AccessDenied`, in S3's XML error shape, so the client's
 * error handling reads it as it would S3's.
 *
 * The access key is the target's id; the secret is sealed on its row. A target
 * that is unknown, finished or expired answers `InvalidAccessKeyId` alike. The
 * body is streamed straight to storage (never buffered), and the bytes become a
 * file only after Oxy hashed them (`fileIngest.service.ts`).
 */

import crypto from 'node:crypto';
import express from 'express';
import { Transform, type Readable } from 'node:stream';
import { fileIngestService } from '../services/fileIngestSingleton';
import { RECORDING_BUCKET } from '../services/fileIngest.service';
import { rateLimit } from '../middleware/rateLimiter';
import { ApiError } from '../utils/error';
import { hashedIpKey } from '../utils/ipKey';
import { logger } from '../utils/logger';
import { AwsChunkedDecoder } from '../utils/awsChunked';
import {
  parseSigV4Authorization,
  SigV4Error,
  STREAMING_UNSIGNED_PAYLOAD_TRAILER,
  UNSIGNED_PAYLOAD,
  verifySigV4,
} from '../utils/sigv4';

const router = express.Router();

/** A `CompleteMultipartUpload` document is small; anything larger is refused. */
const MAX_XML_BYTES = 1024 * 1024;

/** The HTTP status S3 answers an error code with. */
const S3_STATUS: Record<string, number> = {
  AccessDenied: 403,
  InvalidAccessKeyId: 403,
  SignatureDoesNotMatch: 403,
  RequestTimeTooSkewed: 403,
  MissingSecurityHeader: 400,
  AuthorizationHeaderMalformed: 400,
  NoSuchBucket: 404,
  NoSuchUpload: 404,
  InvalidPart: 400,
  InvalidPartOrder: 400,
  InvalidArgument: 400,
  InvalidRequest: 400,
  EntityTooLarge: 400,
  IncompleteBody: 400,
  MalformedXML: 400,
  XAmzContentSHA256Mismatch: 400,
  MissingContentLength: 411,
  NotImplemented: 501,
  UNSUPPORTED_MEDIA_TYPE: 400,
  InternalError: 500,
};

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, '&');
}

function sendXml(res: express.Response, status: number, body: string): void {
  res.status(status);
  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Cache-Control', 'no-store');
  res.end(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`);
}

function sendS3Error(res: express.Response, code: string, message: string, resource: string): void {
  const s3Code = code === 'UNSUPPORTED_MEDIA_TYPE' ? 'InvalidRequest' : code;
  const status = S3_STATUS[code] ?? 500;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendXml(
    res,
    status,
    `<Error><Code>${xmlEscape(s3Code)}</Code><Message>${xmlEscape(message)}</Message><Resource>${xmlEscape(resource)}</Resource><RequestId>${crypto.randomUUID()}</RequestId></Error>`,
  );
}

function header(req: express.Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The request body as the uploader meant it: an `aws-chunked` body decoded,
 * and a body whose SHA-256 was signed checked against it as it passes (the
 * stream errors at its end on a mismatch). Returns the declared length too.
 */
function requestBody(
  req: express.Request,
  payloadHash: string,
): { body: Readable; contentLength: number | undefined } {
  const encoding = (header(req, 'content-encoding') ?? '').toLowerCase();
  const chunked =
    payloadHash === STREAMING_UNSIGNED_PAYLOAD_TRAILER ||
    encoding
      .split(',')
      .map((v) => v.trim())
      .includes('aws-chunked');
  const declared = chunked
    ? header(req, 'x-amz-decoded-content-length')
    : header(req, 'content-length');
  const contentLength =
    declared !== undefined && /^\d+$/.test(declared) ? Number(declared) : undefined;
  let body: Readable = req;
  if (chunked) {
    const decoder = new AwsChunkedDecoder();
    req.on('error', (error) => decoder.destroy(error));
    body = req.pipe(decoder);
  }
  if (payloadHash !== UNSIGNED_PAYLOAD && payloadHash !== STREAMING_UNSIGNED_PAYLOAD_TRAILER) {
    const hash = crypto.createHash('sha256');
    const verifier = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
      flush(callback) {
        if (hash.digest('hex') !== payloadHash) {
          callback(
            new ApiError(
              400,
              'The body does not match its signed hash',
              'XAmzContentSHA256Mismatch',
            ),
          );
          return;
        }
        callback();
      },
    });
    body.on('error', (error) => verifier.destroy(error));
    body = body.pipe(verifier);
  }
  return { body, contentLength };
}

async function readSmallBody(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_XML_BYTES)
      throw new ApiError(400, 'The XML document is too large', 'MalformedXML');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The `<Part>`s of a `CompleteMultipartUpload` document. */
export function parseCompleteMultipartUpload(xml: string): { partNumber: number; etag: string }[] {
  if (!/<CompleteMultipartUpload[\s>]/.test(xml)) {
    throw new ApiError(400, 'Expected a CompleteMultipartUpload document', 'MalformedXML');
  }
  const parts: { partNumber: number; etag: string }[] = [];
  for (const match of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
    const number = /<PartNumber>\s*(\d{1,5})\s*<\/PartNumber>/.exec(match[1]);
    const etag = /<ETag>([\s\S]*?)<\/ETag>/.exec(match[1]);
    if (!number || !etag)
      throw new ApiError(400, 'A part lacks its number or ETag', 'MalformedXML');
    parts.push({ partNumber: Number(number[1]), etag: xmlUnescape(etag[1].trim()) });
  }
  return parts;
}

/** Per-address flood ceiling: the path is exempt from the browser limiters (`isCapabilityUrlPath`). */
const ingestAddressLimiter = rateLimit({
  prefix: 'rl:recording-ingest:ip:',
  windowMs: 15 * 60 * 1000,
  max: 20_000,
  message: 'Too many recording uploads from this address.',
  keyGenerator: (req: express.Request) => `recording-ingest:ip:${hashedIpKey(req)}`,
});

/** Per-target budget: an 8 GiB recording is ~1,640 parts of 5 MiB. */
const ingestTargetLimiter = rateLimit({
  prefix: 'rl:recording-ingest:target:',
  windowMs: 15 * 60 * 1000,
  max: 5_000,
  message: 'Too many requests for this recording target.',
  keyGenerator: (req: express.Request) => {
    try {
      return `recording-ingest:target:${parseSigV4Authorization(header(req, 'authorization')).accessKeyId.slice(0, 64)}`;
    } catch {
      return 'recording-ingest:target:unsigned';
    }
  },
});

router.all(
  '/:bucket/*',
  ingestAddressLimiter,
  ingestTargetLimiter,
  async (req: express.Request, res: express.Response) => {
    const bucket = req.params.bucket;
    const objectName = (req.params as Record<string, string>)[0] ?? '';
    const resource = `/${bucket}/${objectName}`;
    try {
      const auth = parseSigV4Authorization(header(req, 'authorization'));
      const credentials = await fileIngestService.recordingCredentials(auth.accessKeyId);
      if (!credentials) {
        throw new SigV4Error(
          'InvalidAccessKeyId',
          'This recording target does not exist or is closed',
        );
      }
      const { payloadHash } = verifySigV4(
        { method: req.method, rawUrl: req.originalUrl, headers: req.headers },
        auth,
        credentials.secret,
      );
      if (bucket !== RECORDING_BUCKET) {
        throw new ApiError(404, 'The specified bucket does not exist', 'NoSuchBucket');
      }
      const row = credentials.row;
      const query = req.query as Record<string, string | string[] | undefined>;
      const uploadId = typeof query.uploadId === 'string' ? query.uploadId : undefined;
      const method = req.method.toUpperCase();

      if (method === 'PUT' && uploadId === undefined && query.partNumber === undefined) {
        if (header(req, 'x-amz-copy-source')) {
          throw new ApiError(501, 'Copying objects is not supported', 'NotImplemented');
        }
        const { body, contentLength } = requestBody(req, payloadHash);
        const etag = await fileIngestService.putRecordingObject(row, {
          objectName,
          contentType: header(req, 'content-type'),
          body,
          ...(contentLength !== undefined ? { contentLength } : {}),
        });
        res.setHeader('ETag', etag);
        res.status(200).end();
        return;
      }

      if (method === 'PUT' && uploadId !== undefined && typeof query.partNumber === 'string') {
        const { body, contentLength } = requestBody(req, payloadHash);
        if (contentLength === undefined) {
          throw new ApiError(411, 'A part needs its Content-Length', 'MissingContentLength');
        }
        const etag = await fileIngestService.uploadRecordingPart(
          row,
          objectName,
          uploadId,
          Number(query.partNumber),
          body,
          contentLength,
        );
        res.setHeader('ETag', etag);
        res.status(200).end();
        return;
      }

      if (method === 'POST' && query.uploads !== undefined) {
        const created = await fileIngestService.createRecordingMultipart(
          row,
          objectName,
          header(req, 'content-type'),
        );
        sendXml(
          res,
          200,
          `<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(objectName)}</Key><UploadId>${xmlEscape(created)}</UploadId></InitiateMultipartUploadResult>`,
        );
        return;
      }

      if (method === 'POST' && uploadId !== undefined) {
        const { body } = requestBody(req, payloadHash);
        const parts = parseCompleteMultipartUpload(await readSmallBody(body));
        const etag = await fileIngestService.completeRecordingMultipart(
          row,
          objectName,
          uploadId,
          parts,
        );
        const location = `${req.protocol}://${req.get('host') ?? ''}${req.baseUrl}${resource}`;
        sendXml(
          res,
          200,
          `<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Location>${xmlEscape(location)}</Location><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(objectName)}</Key><ETag>${xmlEscape(etag)}</ETag></CompleteMultipartUploadResult>`,
        );
        return;
      }

      if (method === 'DELETE' && uploadId !== undefined) {
        await fileIngestService.abortRecordingMultipart(row, objectName, uploadId);
        res.status(204).end();
        return;
      }

      throw new ApiError(501, 'Only uploads are supported on a recording target', 'NotImplemented');
    } catch (error) {
      if (error instanceof SigV4Error) {
        sendS3Error(res, error.code, error.message, resource);
        return;
      }
      if (error instanceof ApiError) {
        sendS3Error(res, error.code ?? 'InternalError', error.message, resource);
        return;
      }
      logger.error('Recording ingest failed', {
        method: req.method,
        error: error instanceof Error ? error.message : String(error),
      });
      sendS3Error(
        res,
        'InternalError',
        'We encountered an internal error. Please try again.',
        resource,
      );
    }
  },
);

export default router;
