import { type Entity, entity } from '@oxy.so/bloom-data';

/**
 * The id of a value an account holds once: its sign-in methods, its storage
 * usage, its reputation balance. Every account has its own store, so one id
 * serves every account, and the record source that reads the value is keyed
 * by it.
 */
export const ACCOUNT_VALUE = 'account';

/**
 * An entity that holds one server answer per account store, under
 * `ACCOUNT_VALUE`. `persist` copies it to the account's durable store.
 */
export function accountValue<T extends object>(
  type: string,
  options: { persist?: boolean } = {},
): Entity<T> {
  return entity<T>(type, { id: () => ACCOUNT_VALUE, persist: options.persist });
}
