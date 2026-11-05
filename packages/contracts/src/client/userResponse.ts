/**
 * User-response checks, without Zod. Schemas: `../userResponse.ts`.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

import type { UserNameResponse } from '../userResponse';
import { exact, looseObject, optional, string } from './check';

export const userNameCheck = exact<UserNameResponse>()(
  looseObject({
    first: optional(string()),
    last: optional(string()),
    full: optional(string()),
    displayName: optional(string()),
  }),
);

/**
 * Most links a profile may show. Enforced by the server on every write that
 * carries `linksMetadata` (see `user.service.ts`), and by the editor.
 */
export const PROFILE_LINKS_MAX = 10;

/**
 * Longest title an editor may give a profile link, in characters. Not enforced
 * by the server: titles are scraped from remote pages, and a stored title longer
 * than this must still round-trip through a profile write.
 */
export const PROFILE_LINK_TITLE_MAX = 40;
