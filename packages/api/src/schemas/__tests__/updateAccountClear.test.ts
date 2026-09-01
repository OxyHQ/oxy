import { updateAccountSchema } from '../account.schemas';

/**
 * `PATCH /accounts/:id` — clearing a field with `null`.
 *
 * The SDK's `UpdateAccountInput` types `bio` and `avatar` as `string | null` and
 * documents `null` as the clear. This schema is `.strict()`, so until it accepted
 * `null` the WHOLE request was rejected — an account with no bio and no picture
 * could not save its NAME either, because the one field the caller set went down
 * with the two they left empty. From the client that looked like "nothing saves".
 *
 * The fixtures that matter are the ones carrying `null`. A suite that only ever
 * sends strings passes against a schema that rejects `null` and against one that
 * accepts it — which is exactly how this shipped.
 *
 * Tested at the schema rather than through the route: the handler needs a live
 * account context and a child count, and faking three layers to reach one
 * `safeParse` would test the fake.
 */
describe('updateAccountSchema — clearing with null', () => {
  /** The exact body the channel settings form sends with the other two empty. */
  it('accepts a name alongside a null bio and a null avatar', () => {
    const result = updateAccountSchema.safeParse({
      name: { displayName: 'Daily News' },
      bio: null,
      avatar: null,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.bio).toBeNull();
      expect(result.data.avatar).toBeNull();
      expect(result.data.name).toEqual({ displayName: 'Daily News' });
    }
  });

  it.each(['bio', 'avatar'] as const)('accepts %s cleared on its own', (field) => {
    const result = updateAccountSchema.safeParse({ [field]: null });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data[field]).toBeNull();
    }
  });

  it.each(['bio', 'avatar'] as const)('still accepts %s as a string', (field) => {
    const result = updateAccountSchema.safeParse({ [field]: 'something' });
    expect(result.success).toBe(true);
  });

  /**
   * `null` and "absent" are different answers and the schema must keep them
   * apart: one says remove it, the other says leave it alone. `updateAccount`
   * branches on `!== undefined`, so collapsing them would make the clear
   * unreachable while every request still succeeded.
   */
  it('keeps an omitted field distinct from a cleared one', () => {
    const cleared = updateAccountSchema.safeParse({ bio: null });
    const omitted = updateAccountSchema.safeParse({ name: { displayName: 'X' } });

    expect(cleared.success && 'bio' in cleared.data).toBe(true);
    expect(omitted.success && 'bio' in omitted.data).toBe(false);
  });

  /** The strictness that must survive the widening. */
  it('still refuses an unknown field', () => {
    expect(updateAccountSchema.safeParse({ nickname: 'nope' }).success).toBe(false);
  });

  it('still refuses a non-string, non-null bio', () => {
    expect(updateAccountSchema.safeParse({ bio: 42 }).success).toBe(false);
    expect(updateAccountSchema.safeParse({ bio: {} }).success).toBe(false);
  });

  it('still enforces the bio length bound', () => {
    expect(updateAccountSchema.safeParse({ bio: 'x'.repeat(501) }).success).toBe(false);
  });

  /**
   * `description`, `color` and `links` were NOT widened, deliberately: nothing
   * types them as clearable, so accepting `null` there would be inventing a
   * contract rather than honouring one.
   */
  it.each(['description', 'color'] as const)('does not accept null for %s', (field) => {
    expect(updateAccountSchema.safeParse({ [field]: null }).success).toBe(false);
  });
});
