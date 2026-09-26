/**
 * Wire contract for `POST /federation/instance-fetch/sign`: Oxy's INSTANCE
 * actor signs one ActivityPub GET for a first-party service, so the service can
 * read an instance running in authorized-fetch ("secure") mode without holding
 * a key.
 *
 * The caller sends a URL, never a signing string: Oxy builds the string itself
 * (`(request-target): get <path>`, `host`, `date`), the method is always GET
 * and the key is always the instance actor's. The caller sends the returned
 * headers, unchanged, on exactly that URL, within the few minutes remote
 * servers accept a `Date` for. A redirect is a new URL and needs a new
 * signature.
 *
 * Needs a service token whose application holds the privileged
 * `federation:instance-fetch` scope.
 *
 * Platform-agnostic — zod only.
 */

import { z } from 'zod';

/** The longest URL Oxy will sign (the same cap as its own safe fetch). */
export const INSTANCE_FETCH_MAX_URL_LENGTH = 2048;

export const instanceFetchSignRequestSchema = z
  .object({
    /** The absolute public `https://` URL the caller is about to GET. */
    url: z.string().trim().min(1).max(INSTANCE_FETCH_MAX_URL_LENGTH),
  })
  .strict();

export type InstanceFetchSignRequest = z.infer<typeof instanceFetchSignRequestSchema>;

export const instanceFetchSignResponseSchema = z
  .object({
    /** The instance actor's key, e.g. `https://oxy.so/ap/users/instance#main-key`. */
    keyId: z.string().url(),
    /** Send all three on the GET, as they are. */
    headers: z
      .object({
        Host: z.string().min(1),
        Date: z.string().min(1),
        Signature: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type InstanceFetchSignResponse = z.infer<typeof instanceFetchSignResponseSchema>;
