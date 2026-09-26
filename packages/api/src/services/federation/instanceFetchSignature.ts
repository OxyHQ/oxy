/**
 * Oxy's instance actor signs one ActivityPub GET for a first-party service —
 * `POST /federation/instance-fetch/sign`, scope `federation:instance-fetch`.
 *
 * Why the INSTANCE actor. A server in authorized-fetch ("secure") mode answers
 * an unsigned GET 401 and serves public content to any signer whose key it can
 * fetch and whose domain it has not blocked. The service asking (Oxy Move)
 * reads PUBLIC outboxes and `following` collections on the user's behalf; it
 * must not speak as any person. `https://oxy.so/ap/users/instance` is the
 * server-level `Application` actor Oxy already signs its own reads with
 * (`signedFetch` in `federation.service.ts`), it is WebFinger-resolvable
 * (`acct:instance@oxy.so`, which Mastodon's key fetch requires), and it follows
 * nobody, so a signature from it unlocks nothing followers-only. A remote
 * admin sees `oxy.so` fetching, which is the truth: Move is part of Oxy.
 *
 * What makes this narrower than `/federation/sign`:
 *
 * - The caller sends a URL, not a signing string. Oxy composes the string from
 *   the URL with `@oxy.so/federation`'s `signRequest` — `(request-target): get
 *   <path>`, `host`, `date` — so the method is GET by construction and nothing
 *   the caller writes ends up inside the signed bytes except the URL itself.
 * - The key is always the instance actor's. No keyId is accepted.
 * - The URL must be `https:`, carry no credentials, and resolve to a public
 *   address (`assertSafePublicUrl`, the same rule `safeFetch` applies). Oxy
 *   never fetches it; the check keeps the signature from being minted for an
 *   internal host.
 *
 * The signature is bound to that URL and a `Date` remote servers accept for a
 * few minutes; a redirect is a new URL and needs a new signature.
 */

import { assertSafePublicUrl } from '@oxy.so/core/server';
import { signRequest } from '@oxy.so/federation';
import { INSTANCE_FETCH_MAX_URL_LENGTH, type InstanceFetchSignResponse } from '@oxy.so/contracts';
import { ensureInstanceKeyId, signWithKeyId } from '../federation.service';

export type InstanceFetchRefusalReason = 'invalid_url' | 'not_https' | 'credentials_in_url' | 'not_public';

/** A URL Oxy will not sign a GET for. */
export class InstanceFetchRefused extends Error {
  readonly reason: InstanceFetchRefusalReason;
  constructor(reason: InstanceFetchRefusalReason, message: string) {
    super(message);
    this.name = 'InstanceFetchRefused';
    this.reason = reason;
  }
}

/** The instance key is missing and could not be minted. */
export class InstanceKeyUnavailable extends Error {
  constructor() {
    super('the instance actor key is unavailable');
    this.name = 'InstanceKeyUnavailable';
  }
}

export async function signInstanceFetch(rawUrl: string): Promise<InstanceFetchSignResponse> {
  if (rawUrl.length > INSTANCE_FETCH_MAX_URL_LENGTH) throw new InstanceFetchRefused('invalid_url', 'url is too long');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new InstanceFetchRefused('invalid_url', 'url is not an absolute URL');
  }
  if (url.protocol !== 'https:') throw new InstanceFetchRefused('not_https', 'only https URLs are signed');
  if (url.username !== '' || url.password !== '') {
    throw new InstanceFetchRefused('credentials_in_url', 'a URL with credentials is not signed');
  }
  const verdict = await assertSafePublicUrl(url.toString());
  if (!verdict.ok) throw new InstanceFetchRefused('not_public', `url is not a public address (${verdict.reason})`);

  const keyId = await ensureInstanceKeyId();
  const headers = await signRequest(
    async (signingKeyId, signingString) => {
      const signature = await signWithKeyId(signingKeyId, signingString);
      if (signature === null) throw new InstanceKeyUnavailable();
      return signature;
    },
    keyId,
    'GET',
    url.toString(),
  );
  return { keyId, headers: { Host: headers.Host, Date: headers.Date, Signature: headers.Signature } };
}
