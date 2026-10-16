/**
 * Receiving Oxy's file events (ADR 0043 D9).
 *
 * Oxy tells an application about the files it uses or owns — a file was
 * deleted, moved to trash, restored, or changed visibility — by POSTing JSON
 * to the application's verified file-events endpoint (set with
 * `oxy.apps.setFilesWebhook`). Each request is signed:
 *
 *     oxy-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * {@link verifyFileEventSignature} checks that header against the RAW body
 * (the exact bytes received — parse the JSON only afterwards), refuses a
 * timestamp outside the replay window, and returns the parsed event. Delivery
 * is at least once: dedupe on `event.id`.
 *
 * ```ts
 * app.post('/webhooks/oxy/files', express.raw({ type: 'application/json' }), (req, res) => {
 *   const event = verifyFileEventSignature(req.body, req.headers, process.env.OXY_FILES_WEBHOOK_SECRET!);
 *   if (event.type === 'webhook.challenge') return res.json({ challenge: event.challenge });
 *   // event.type: 'file.deleted' | 'file.trashed' | …; event.references are YOUR uses of the file
 *   res.sendStatus(204);
 * });
 * ```
 *
 * The one unsigned-by-a-known-secret request is the endpoint's verification
 * challenge, sent when the endpoint is set (its new secret is shown only in
 * that call's response): {@link verifyFileEventSignature} returns it without
 * checking the signature, so the receiver can echo `challenge`. Nothing else
 * may be done with it.
 *
 * The same endpoint also receives `stream.key_authorization` (ADR 0042 stage
 * 4c) when the application starts a play session with
 * `keyAuthorization: 'webhook'`: a SYNCHRONOUS request, signed the same way,
 * that must be answered within 3 s with `{ "allow": true }` for the player to
 * get the content key. It is not a file event — branch on the
 * `oxy-event-type` header and verify it with `verifyStreamKeyAuthorization`
 * (`./streamKeyAuthorization.ts`); {@link verifyFileEventSignature} refuses it.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Every file event type. `file.blocked`/`file.unblocked` arrive with content takedowns. */
export const FILE_EVENT_TYPES = [
  'file.deleted',
  'file.visibility_changed',
  'file.trashed',
  'file.restored',
  'file.blocked',
  'file.unblocked',
] as const;

export type FileEventType = (typeof FILE_EVENT_TYPES)[number];

/** One file event, as Oxy sends it. */
export interface FileEvent {
  /** The event id: the same for every application told of the same change. Dedupe on it. */
  id: string;
  type: FileEventType;
  occurredAt: string;
  file: {
    id: string;
    /** Who owns the file — never which account. */
    ownerKind: 'account' | 'application' | 'platform';
    visibility: 'public' | 'unlisted' | 'private';
    /** The file's status after the change: `deleted`, `trash`, `active` or `blocked`. */
    status: string;
  };
  /** YOUR application's references to the file (empty when you own it and do not reference it). */
  references: Array<{ entityType: string; entityId: string }>;
}

/** The endpoint verification Oxy sends when the endpoint is set: echo `{ challenge }`. */
export interface FileWebhookChallenge {
  type: 'webhook.challenge';
  challenge: string;
}

/** Why a request was not accepted as a file event. */
export class FileEventVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileEventVerificationError';
  }
}

/** The signature header. */
export const FILE_EVENT_SIGNATURE_HEADER = 'oxy-signature';

/** Default replay window: five minutes either side of now. */
export const FILE_EVENT_DEFAULT_TOLERANCE_SECONDS = 300;

export type HeaderBag =
  | Headers
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null };

function readHeader(headers: HeaderBag, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(name: string): string | null }).get(name) ?? undefined;
  }
  const bag = headers as Record<string, string | string[] | undefined>;
  const direct = bag[name] ?? bag[name.toLowerCase()];
  const value =
    direct ?? Object.entries(bag).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  return Array.isArray(value) ? value[0] : value;
}

export function rawText(rawBody: string | Uint8Array | ArrayBuffer): string {
  if (typeof rawBody === 'string') return rawBody;
  const bytes = rawBody instanceof Uint8Array ? rawBody : new Uint8Array(rawBody);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** `t=<int>,v1=<hex>[,v1=<hex>…]`: the timestamp and every v1 signature. */
function parseSignatureHeader(value: string): { timestamp: number; signatures: string[] } {
  let timestamp = Number.NaN;
  const signatures: string[] = [];
  for (const part of value.split(',')) {
    const [key, ...rest] = part.trim().split('=');
    const item = rest.join('=');
    if (key === 't' && /^\d+$/.test(item)) timestamp = Number(item);
    else if (key === 'v1' && /^[0-9a-f]{64}$/i.test(item)) signatures.push(item.toLowerCase());
  }
  return { timestamp, signatures };
}

/**
 * Check `oxy-signature` over `text` (the raw body) with `secret`, inside the
 * replay window — the one signature scheme of every request Oxy sends an
 * application's file-events endpoint (file events, and the synchronous
 * `stream.key_authorization`, `./streamKeyAuthorization.ts`). Throws `Failure`.
 */
export function verifyOxySignature(
  text: string,
  headers: HeaderBag,
  secret: string,
  options: { toleranceSeconds?: number; now?: Date },
  Failure: new (message: string) => Error,
): void {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Failure('No signing secret configured');
  }
  const header = readHeader(headers, FILE_EVENT_SIGNATURE_HEADER);
  if (!header) throw new Failure('Missing oxy-signature header');
  const { timestamp, signatures } = parseSignatureHeader(header);
  if (!Number.isFinite(timestamp) || signatures.length === 0) {
    throw new Failure('Malformed oxy-signature header');
  }
  const tolerance = options.toleranceSeconds ?? FILE_EVENT_DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - timestamp) > tolerance) {
    throw new Failure('The signature timestamp is outside the replay window');
  }
  const expected = Buffer.from(
    createHmac('sha256', secret).update(`${timestamp}.${text}`).digest('hex'),
    'utf8',
  );
  const matches = signatures.some((signature) => {
    const given = Buffer.from(signature, 'utf8');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!matches) throw new Failure('The signature does not match');
}

/**
 * Verify one request from Oxy and return its event. Throws
 * {@link FileEventVerificationError} when the signature is missing, malformed
 * or wrong, the timestamp is outside `toleranceSeconds` (default 300) of now,
 * or the body is not a file event. A `webhook.challenge` is returned without a
 * signature check (see the module header).
 *
 * @param rawBody - The request body EXACTLY as received (not re-serialized JSON).
 * @param headers - The request headers (a Node header object or a fetch `Headers`).
 * @param secret - The `whsec_…` secret `apps.setFilesWebhook` returned.
 */
export function verifyFileEventSignature(
  rawBody: string | Uint8Array | ArrayBuffer,
  headers: HeaderBag,
  secret: string,
  options: { toleranceSeconds?: number; now?: Date } = {},
): FileEvent | FileWebhookChallenge {
  let text: string;
  try {
    text = rawText(rawBody);
  } catch {
    throw new FileEventVerificationError('The body is not UTF-8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FileEventVerificationError('The body is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new FileEventVerificationError('The body is not a file event');
  }
  const record = parsed as Record<string, unknown>;

  if (record.type === 'webhook.challenge') {
    if (typeof record.challenge !== 'string' || record.challenge.length === 0) {
      throw new FileEventVerificationError('The challenge carries no value');
    }
    return { type: 'webhook.challenge', challenge: record.challenge };
  }

  verifyOxySignature(text, headers, secret, options, FileEventVerificationError);

  const file = record.file as Record<string, unknown> | undefined;
  if (
    typeof record.id !== 'string' ||
    typeof record.type !== 'string' ||
    !(FILE_EVENT_TYPES as readonly string[]).includes(record.type) ||
    typeof file !== 'object' ||
    file === null ||
    typeof file.id !== 'string' ||
    !Array.isArray(record.references)
  ) {
    throw new FileEventVerificationError('The body is not a file event');
  }
  return parsed as FileEvent;
}
