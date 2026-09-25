import crypto from 'node:crypto';
import type { Request, Response } from 'express';

/**
 * `GET /csrf-token` for clients that still ask for one. The token guards nothing.
 *
 * The API has no ambient credential. Every write authenticates with an explicit
 * `Authorization` header, which a browser never attaches to a cross-site request
 * on its own, and the API sets no cookie at all (issue #1044). CSRF had nothing
 * left to defend, so the double-submit layer and `cookie-parser` are gone.
 *
 * `@oxy.so/core` up to 1.7.4 still fetches this route before any write that
 * carries no bearer. When the fetch fails, that client retries with a backoff
 * before every such write, and one of those writes is the high-volume anonymous
 * `POST /users/by-ids`. So the route stays and answers at once: a random opaque
 * value, no cookie, nothing stored, nothing checked. Delete the route once
 * clients older than the release that stopped calling it are no longer in use.
 */
export function getCsrfTokenCompat(_req: Request, res: Response): void {
  res.set('Cache-Control', 'no-store').json({ csrfToken: crypto.randomBytes(32).toString('base64url') });
}
