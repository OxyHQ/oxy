import { z } from 'zod';
// The Zod-free half of this contract lives in `./client/` (`@oxy.so/contracts/client`);
// it is re-exported here so the root entry carries the whole policy.
import { ACCOUNT_TITLE_MAX_LENGTH, isPlainTextTitle } from './client/accountName';
export {
  ACCOUNT_NAME_POLICY_BY_KIND,
  ACCOUNT_TITLE_DISALLOWED_SOURCE,
  ACCOUNT_TITLE_MAX_LENGTH,
  accountNamePolicyForKind,
  isPlainTextTitle,
} from './client/accountName';
export type { AccountNamePolicy } from './client/accountName';

/** A non-personal account's title — see `./client/accountName.ts` for the policy. */
export const accountTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(ACCOUNT_TITLE_MAX_LENGTH)
  .refine(isPlainTextTitle, 'Name must be plain text');
