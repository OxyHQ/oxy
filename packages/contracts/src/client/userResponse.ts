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
/**
 * How an account names its pronouns: one of a closed list, never free text. A
 * federated account's source value is mapped onto it; a value that maps to none
 * of these is `unspecified`.
 */
export const PRONOUNS = [
  'unspecified',
  'he_him',
  'she_her',
  'they_them',
  'he_they',
  'she_they',
  'it_its',
] as const;
export type Pronouns = (typeof PRONOUNS)[number];

export const PROFILE_LINKS_MAX = 10;

/**
 * Longest title an editor may give a profile link, in characters. Not enforced
 * by the server: titles are scraped from remote pages, and a stored title longer
 * than this must still round-trip through a profile write.
 */
export const PROFILE_LINK_TITLE_MAX = 40;
