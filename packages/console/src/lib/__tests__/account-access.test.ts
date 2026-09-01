import { describe, expect, it } from 'vitest';
import type { AccountRelationship } from '@oxyhq/core';
import { hasImplicitOwnership } from '@/lib/account-access';

/**
 * The client's half of `effectiveAccessForAccount`'s first branch.
 *
 * The server short-circuits on `userId === accountId` and answers `{ role:
 * 'owner', permissions: <all of them>, source: 'self', membership: null }`. The
 * node it then serialises carries `relationship: 'self'` and a null
 * `callerMembership` — so a gate reading only the membership refuses the caller
 * everything on the account they own outright, which is the one the Console
 * opens on.
 */
describe('hasImplicitOwnership', () => {
  it('recognises the caller\'s own personal account', () => {
    expect(hasImplicitOwnership({ relationship: 'self' })).toBe(true);
  });

  /**
   * The control: every other relationship goes through the membership row,
   * INCLUDING `owner`. An organization's owner holds a real row with real
   * permissions, and a per-member revoke can take one away — inferring the
   * permission set from the word "owner" is exactly what the Console must not do.
   */
  it('does not extend to an owned account that is not the caller\'s own', () => {
    for (const relationship of ['owner', 'member'] as const satisfies ReadonlyArray<AccountRelationship>) {
      expect(hasImplicitOwnership({ relationship })).toBe(false);
    }
  });
});
