import type { User } from '@oxy.so/core';

/**
 * Extended User type for the accounts app.
 *
 * The base `@oxy.so/core` `User` already declares `phone`, `address`, and
 * `birthday` (all `string | undefined`), so they are inherited as-is — an
 * interface cannot re-widen an inherited optional field with `null`. This type
 * only ADDS `dateOfBirth`, which the base type does not declare.
 */
export interface ExtendedUser extends User {
  /**
   * User's date of birth (alternative to `birthday`). Not present on the base
   * `User` type, so it is additive here.
   */
  dateOfBirth?: string | null;
}
