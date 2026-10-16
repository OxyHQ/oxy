/**
 * Verifying an application's file-events endpoint before it is stored
 * (ADR 0042 D9, `PUT /applications/:appId/files-webhook`).
 *
 * Oxy POSTs `{ "type": "webhook.challenge", "challenge": "<random>" }`, signed
 * like every file event with the NEW secret (`oxy-signature`), and stores the
 * endpoint only when it answers 2xx with a JSON body whose `challenge` is the
 * same value. That proves the developer controls the URL and that it is a
 * receiver for these events, not some page that happens to answer 200. The
 * receiver does not know the new secret yet — it is shown with the response —
 * so it answers the challenge without checking the signature; the challenge
 * carries nothing to protect.
 *
 * Through `safeFetch` (public addresses only, DNS-pinned, no redirects), at
 * most {@link CHALLENGE_TIMEOUT_MS}, reading at most
 * {@link CHALLENGE_MAX_BODY_BYTES} of the answer.
 */

import crypto from 'node:crypto';
import { safeFetch, SsrfRejection } from '@oxy.so/core/server';
import { ApiError } from '../utils/error';
import { FILE_EVENT_SIGNATURE_HEADER, fileEventSignatureHeader } from './fileEvents.service';

export const CHALLENGE_TIMEOUT_MS = 10_000;
export const CHALLENGE_MAX_BODY_BYTES = 4096;

/** Why an endpoint was not accepted, said to the developer. */
function refused(message: string): ApiError {
  return new ApiError(422, message, 'WEBHOOK_VERIFICATION_FAILED');
}

/**
 * Send the challenge to `url` signed with `secret`; resolve when it was echoed,
 * throw a 422 `WEBHOOK_VERIFICATION_FAILED` saying why otherwise.
 */
export async function verifyFilesWebhookEndpoint(url: string, secret: string): Promise<void> {
  const challenge = crypto.randomBytes(24).toString('base64url');
  const body = JSON.stringify({ type: 'webhook.challenge', challenge });
  let result: Awaited<ReturnType<typeof safeFetch>>;
  try {
    result = await safeFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'oxy-event-type': 'webhook.challenge',
        [FILE_EVENT_SIGNATURE_HEADER]: fileEventSignatureHeader(secret, body),
      },
      body,
      maxRedirects: 0,
      headersTimeoutMs: CHALLENGE_TIMEOUT_MS,
      signal: AbortSignal.timeout(CHALLENGE_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof SsrfRejection) {
      throw refused('The endpoint does not resolve to a public address');
    }
    throw refused('The endpoint could not be reached');
  }

  const { response, status } = result;
  if (status < 200 || status >= 300) {
    response.destroy();
    throw refused(`The endpoint answered the challenge with HTTP ${status}`);
  }

  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > CHALLENGE_MAX_BODY_BYTES) {
        response.destroy();
        throw refused('The endpoint answered the challenge with too large a body');
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw refused('The endpoint could not be read');
  }

  let answered: unknown;
  try {
    answered = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    answered = undefined;
  }
  if (
    typeof answered !== 'object' ||
    answered === null ||
    (answered as { challenge?: unknown }).challenge !== challenge
  ) {
    throw refused('The endpoint did not echo the challenge as {"challenge": "<value>"}');
  }
}
