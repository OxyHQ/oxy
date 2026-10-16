/**
 * Authorizing a play session's content key (ADR 0042 stage 4c).
 *
 * A play session (`OxyServer.assets.streams.create`) with
 * `keyAuthorization: 'webhook'` makes Oxy ask the application before it serves
 * the session's AES-128 key to a player: a synchronous POST to the
 * application's verified file-events endpoint (`oxy.apps.setFilesWebhook`),
 * signed exactly like a file event —
 *
 *     oxy-event-type: stream.key_authorization
 *     oxy-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * — whose body names the session. The application checks its OWN entitlement
 * (is this end user still subscribed, still in the room…) and answers within
 * 3 s with a 2xx `{ "allow": true }`. Anything else — `{ "allow": false }`, a
 * non-2xx status, a timeout, a body that is not that JSON — denies the key, and
 * the player cannot decrypt a single segment. Oxy remembers an answer for a
 * session for about a minute.
 *
 * ```ts
 * app.post('/webhooks/oxy/files', express.raw({ type: 'application/json' }), async (req, res) => {
 *   if (req.get('oxy-event-type') === STREAM_KEY_AUTHORIZATION_EVENT_TYPE) {
 *     const request = verifyStreamKeyAuthorization(req.body, req.headers, secret);
 *     const allow = await entitled(request.session.endUserId, request.session.fileId);
 *     return res.json({ allow } satisfies StreamKeyAuthorizationAnswer);
 *   }
 *   const event = verifyFileEventSignature(req.body, req.headers, secret);
 *   // …
 * });
 * ```
 */
import { rawText, verifyOxySignature, type HeaderBag } from './fileEvents';

/** The `type` (and `oxy-event-type` header) of a key authorization request. */
export const STREAM_KEY_AUTHORIZATION_EVENT_TYPE = 'stream.key_authorization';

/** One key authorization request, as Oxy sends it. */
export interface StreamKeyAuthorizationRequest {
  /** Unique per request. */
  id: string;
  type: typeof STREAM_KEY_AUTHORIZATION_EVENT_TYPE;
  occurredAt: string;
  session: {
    id: string;
    fileId: string;
    /** The end user the session was created for, if any. */
    endUserId: string | null;
    expiresAt: string;
  };
}

/** The answer Oxy expects: a 2xx with this JSON. Anything else denies. */
export interface StreamKeyAuthorizationAnswer {
  allow: boolean;
}

/** Why a request was not accepted as a key authorization request. */
export class StreamKeyAuthorizationVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamKeyAuthorizationVerificationError';
  }
}

/**
 * Verify one key authorization request from Oxy and return it. Throws
 * {@link StreamKeyAuthorizationVerificationError} when the signature is
 * missing, malformed or wrong, its timestamp is outside `toleranceSeconds`
 * (default 300) of now, or the body is not a key authorization request. Answer
 * a refused request with a non-2xx status (Oxy then denies the key).
 *
 * @param rawBody - The request body EXACTLY as received.
 * @param headers - The request headers (a Node header object or a fetch `Headers`).
 * @param secret - The file-events endpoint's secret (`apps.setFilesWebhook`).
 */
export function verifyStreamKeyAuthorization(
  rawBody: string | Uint8Array | ArrayBuffer,
  headers: HeaderBag,
  secret: string,
  options: { toleranceSeconds?: number; now?: Date } = {},
): StreamKeyAuthorizationRequest {
  let text: string;
  try {
    text = rawText(rawBody);
  } catch {
    throw new StreamKeyAuthorizationVerificationError('The body is not UTF-8');
  }
  verifyOxySignature(text, headers, secret, options, StreamKeyAuthorizationVerificationError);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StreamKeyAuthorizationVerificationError('The body is not JSON');
  }
  const record =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  const session =
    record && typeof record.session === 'object' && record.session !== null
      ? (record.session as Record<string, unknown>)
      : null;
  if (
    !record ||
    record.type !== STREAM_KEY_AUTHORIZATION_EVENT_TYPE ||
    typeof record.id !== 'string' ||
    typeof record.occurredAt !== 'string' ||
    !session ||
    typeof session.id !== 'string' ||
    typeof session.fileId !== 'string' ||
    typeof session.expiresAt !== 'string' ||
    !(session.endUserId === null || typeof session.endUserId === 'string')
  ) {
    throw new StreamKeyAuthorizationVerificationError(
      'The body is not a key authorization request',
    );
  }
  return {
    id: record.id,
    type: STREAM_KEY_AUTHORIZATION_EVENT_TYPE,
    occurredAt: record.occurredAt,
    session: {
      id: session.id,
      fileId: session.fileId,
      endUserId: session.endUserId as string | null,
      expiresAt: session.expiresAt,
    },
  };
}
