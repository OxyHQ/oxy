import {
  ACCOUNT_CATEGORY_IDS,
  ACCOUNT_CATEGORY_KINDS,
  ACCOUNT_KINDS,
  CHILD_ACCOUNT_KINDS,
  MAX_ACCOUNT_CATEGORIES,
  RETIRED_ACCOUNT_CATEGORY_IDS,
  SELECTABLE_ACCOUNT_CATEGORY_IDS,
  accountCategoriesSchema,
  accountCategoryIdSchema,
  createAccountRequestSchema,
  isAccountKind,
  isDelegatedActAsEligibleKind,
  isOperatorSwitchTargetKind,
  isSelectableAccountCategoryId,
  kindAcceptsAccountCategories,
  newlyAddedRetiredCategories,
  type AccountCategoryId,
} from '../accountGraph';
import { userResponseSchema } from '../userResponse';

describe('@oxyhq/contracts account kinds', () => {
  it('carries channel as a child kind, and personal as the only root', () => {
    expect([...ACCOUNT_KINDS]).toEqual([
      'personal',
      'organization',
      'project',
      'bot',
      'channel',
    ]);
    expect([...CHILD_ACCOUNT_KINDS]).toEqual(['organization', 'project', 'bot', 'channel']);
    expect(CHILD_ACCOUNT_KINDS).not.toContain('personal');
  });

  it('accepts a channel as a create-account kind', () => {
    const parsed = createAccountRequestSchema.safeParse({
      kind: 'channel',
      username: 'daily-news',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts categories on a channel', () => {
    const parsed = createAccountRequestSchema.safeParse({
      kind: 'channel',
      username: 'daily-news',
      accountCategories: ['news', 'politics'],
    });
    expect(parsed.success).toBe(true);
  });

  /**
   * `z.object()` STRIPS an unknown key rather than rejecting it, so a field the
   * API reads but this schema never declared arrives as `undefined` with no
   * validation error anywhere. That is why the contract half is asserted on the
   * PARSED OUTPUT and not merely on `success` — `safeParse` would report `true`
   * for a schema that silently threw the field away.
   */
  it('carries isPrivateAccount through the parse, rather than stripping it', () => {
    const parsed = createAccountRequestSchema.safeParse({
      kind: 'bot',
      username: 'unpublished-agent',
      isPrivateAccount: true,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.isPrivateAccount).toBe(true);
  });

  it('leaves isPrivateAccount undefined when it is not supplied', () => {
    // Undefined, never `false`. The API distinguishes "the caller did not say"
    // — which falls through to the column default — from "the caller said
    // discoverable", and a schema defaulting it here would erase that.
    const parsed = createAccountRequestSchema.safeParse({
      kind: 'bot',
      username: 'ordinary-agent',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'isPrivateAccount' in parsed.data).toBe(false);
  });

  /**
   * Same reasoning as `isPrivateAccount` above, and the same failure it guards:
   * the API names every create field explicitly, so a `color` this schema strips
   * reaches the insert as `undefined` and the account is born with a RANDOM
   * preset — a success, with the wrong face, reported nowhere.
   */
  it('carries color through the parse, rather than stripping it', () => {
    const parsed = createAccountRequestSchema.safeParse({
      kind: 'bot',
      username: 'agent-with-a-colour',
      color: 'purple',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.color).toBe('purple');
  });

  it('leaves color undefined when it is not supplied', () => {
    // Undefined, never a fallback picked here: the column's own default is a
    // random non-reserved preset, and a value invented in this schema would
    // replace that with whatever one file happened to name.
    const parsed = createAccountRequestSchema.safeParse({
      kind: 'bot',
      username: 'ordinary-agent',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'color' in parsed.data).toBe(false);
  });

  it('rejects a color that is not a string, or is longer than a preset key', () => {
    for (const color of [{ hex: '#fff' }, 'x'.repeat(33)]) {
      const parsed = createAccountRequestSchema.safeParse({
        kind: 'bot',
        username: 'agent',
        color,
      });
      expect(parsed.success).toBe(false);
    }
  });

  it('rejects a non-boolean isPrivateAccount', () => {
    const parsed = createAccountRequestSchema.safeParse({
      kind: 'bot',
      username: 'agent',
      isPrivateAccount: 'yes',
    });
    expect(parsed.success).toBe(false);
  });

  /**
   * The DELEGATION partition, stated as a full truth table over EVERY kind rather
   * than a spot check — the failure this guards is a new kind silently landing
   * on the eligible side of a `kind === 'personal'` test.
   */
  it('admits only organization/project/bot as a delegated subject', () => {
    const verdicts = Object.fromEntries(
      ACCOUNT_KINDS.map((kind) => [kind, isDelegatedActAsEligibleKind(kind)])
    );
    expect(verdicts).toEqual({
      personal: false,
      organization: true,
      project: true,
      bot: true,
      channel: false,
    });
  });

  /**
   * The SWITCHER partition. `bot` is the one row that differs from the table
   * above, and it is the reason there are two predicates: an application acting
   * as a bot is the bot's purpose, while a person switching into one seats a
   * human inside an identity built to run without one.
   */
  it('refuses bot as well as channel to a person switching accounts', () => {
    const verdicts = Object.fromEntries(
      ACCOUNT_KINDS.map((kind) => [kind, isOperatorSwitchTargetKind(kind)])
    );
    expect(verdicts).toEqual({
      personal: false,
      organization: true,
      project: true,
      bot: false,
      channel: false,
    });
  });

  it('treats a missing kind as ineligible, on both', () => {
    expect(isDelegatedActAsEligibleKind(undefined)).toBe(false);
    expect(isDelegatedActAsEligibleKind(null)).toBe(false);
    expect(isOperatorSwitchTargetKind(undefined)).toBe(false);
    expect(isOperatorSwitchTargetKind(null)).toBe(false);
  });

  it('narrows only real kinds', () => {
    for (const kind of ACCOUNT_KINDS) {
      expect(isAccountKind(kind)).toBe(true);
    }
    for (const notAKind of ['', 'Channel', 'user', 'local', null, undefined, 3, {}]) {
      expect(isAccountKind(notAKind)).toBe(false);
    }
  });

  /**
   * `kind` and `type` are different axes that coexist — `type` says where an
   * account lives and how it is driven, `kind` says what it is. Neither value
   * belongs in the other's vocabulary, and confusing them is the likeliest way
   * a consumer misreads a channel.
   */
  it('shares no value with the federation type vocabulary', () => {
    const federationTypes = ['local', 'federated', 'agent', 'automated'];
    for (const kind of ACCOUNT_KINDS) {
      expect(federationTypes).not.toContain(kind);
    }
  });

  it('accepts an explicit displayName when creating an account', () => {
    const parsed = createAccountRequestSchema.safeParse({
      kind: 'channel',
      username: 'notas-de-nate',
      name: { displayName: 'Notas de Nate' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name?.displayName).toBe('Notas de Nate');
      // The title does NOT land in the given-name field.
      expect(parsed.data.name?.first).toBeUndefined();
    }
  });
});

describe('@oxyhq/contracts account categories', () => {
  /**
   * The four ids the single-valued predecessor could hold. Live rows carry
   * them, so losing one is losing a stored choice — rule 1 and rule 3 both.
   */
  it('keeps every id the single-valued field could hold', () => {
    for (const carried of ['agency', 'cooperative', 'landlord', 'other']) {
      expect(ACCOUNT_CATEGORY_IDS).toContain(carried);
    }
  });

  it('declares ids as opaque lowercase slugs, with no duplicates', () => {
    expect(new Set(ACCOUNT_CATEGORY_IDS).size).toBe(ACCOUNT_CATEGORY_IDS.length);
    for (const id of ACCOUNT_CATEGORY_IDS) {
      expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('rejects an id the vocabulary does not define', () => {
    expect(accountCategoryIdSchema.safeParse('broker').success).toBe(false);
    // A LABEL is not an id. This is the shape a client would send if it ever
    // round-tripped the rendered text instead of the slug.
    expect(accountCategoryIdSchema.safeParse('Real estate agency').success).toBe(false);
  });

  // ---- the cap -------------------------------------------------------------

  it('accepts exactly the cap and refuses one more', () => {
    const atCap = ACCOUNT_CATEGORY_IDS.slice(0, MAX_ACCOUNT_CATEGORIES);
    const overCap = ACCOUNT_CATEGORY_IDS.slice(0, MAX_ACCOUNT_CATEGORIES + 1);
    // Both fixtures must be REAL, so the refusal below is the cap and not the
    // vocabulary — the vocabulary is longer than the cap, which is what makes
    // an over-cap fixture of valid ids constructible at all.
    expect(overCap.length).toBe(MAX_ACCOUNT_CATEGORIES + 1);
    expect(atCap.every((id) => accountCategoryIdSchema.safeParse(id).success)).toBe(true);
    expect(overCap.every((id) => accountCategoryIdSchema.safeParse(id).success)).toBe(true);

    expect(accountCategoriesSchema.safeParse(atCap).success).toBe(true);

    const refused = accountCategoriesSchema.safeParse(overCap);
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error.issues.some((issue) => issue.code === 'too_big')).toBe(true);
    }
  });

  it('accepts an empty list', () => {
    expect(accountCategoriesSchema.safeParse([]).success).toBe(true);
  });

  it('refuses a duplicate rather than collapsing it', () => {
    const parsed = accountCategoriesSchema.safeParse(['news', 'sports', 'news']);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // Named at the offending INDEX, not just "invalid".
      expect(parsed.error.issues[0]?.path).toEqual([2]);
      expect(parsed.error.issues[0]?.message).toContain('news');
    }
  });

  // ---- order is data -------------------------------------------------------

  /**
   * The primary is the first element, so the schema must be order-PRESERVING,
   * not merely order-tolerant. The fixture is deliberately three long with a
   * primary that is neither alphabetically first (`news` > `art`, `film`) nor
   * first in `ACCOUNT_CATEGORY_IDS` (`art` and `film` both follow `news`… so
   * the declaration order is asserted too) — an accidental sort on either key
   * would move it.
   */
  it('preserves order, so index 0 stays the primary', () => {
    const chosen: AccountCategoryId[] = ['news', 'art', 'film'];
    const alphabetical = [...chosen].sort();
    const declarationOrder = [...chosen].sort(
      (a, b) => ACCOUNT_CATEGORY_IDS.indexOf(a) - ACCOUNT_CATEGORY_IDS.indexOf(b)
    );
    // The fixture can tell a sort from a pass-through only if the sorts DIFFER
    // from it. Assert that before trusting the round-trip below.
    expect(alphabetical).not.toEqual(chosen);
    expect(declarationOrder).not.toEqual(chosen);

    const parsed = accountCategoriesSchema.safeParse(chosen);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual(chosen);
      expect(parsed.data[0]).toBe('news');
    }
  });

  // ---- the kind restriction ------------------------------------------------

  /**
   * A full truth table over EVERY kind, not a spot check: the failure this
   * guards is a kind added later landing on the permitted side of a
   * `kind !== 'personal'` test nobody revisited.
   */
  it('admits every kind except personal', () => {
    const verdicts = Object.fromEntries(
      ACCOUNT_KINDS.map((kind) => [kind, kindAcceptsAccountCategories(kind)])
    );
    expect(verdicts).toEqual({
      personal: false,
      organization: true,
      project: true,
      bot: true,
      channel: true,
    });
  });

  it('treats a missing kind as ineligible', () => {
    expect(kindAcceptsAccountCategories(undefined)).toBe(false);
    expect(kindAcceptsAccountCategories(null)).toBe(false);
  });

  /**
   * `createAccountRequestSchema` carries NO cross-field refinement for
   * categories, and is only correct in doing so while every child kind accepts
   * them. This is the assertion that keeps that reasoning true.
   */
  it('accepts categories on every kind the create route can mint', () => {
    for (const kind of CHILD_ACCOUNT_KINDS) {
      expect(kindAcceptsAccountCategories(kind)).toBe(true);
      const parsed = createAccountRequestSchema.safeParse({
        kind,
        username: `acct-${kind}`,
        accountCategories: ['news'],
      });
      expect(parsed.success).toBe(true);
    }
    expect([...ACCOUNT_CATEGORY_KINDS].sort()).toEqual([...CHILD_ACCOUNT_KINDS].sort());
  });

  // ---- withdrawal ----------------------------------------------------------

  it('offers every id while none is withdrawn', () => {
    expect(RETIRED_ACCOUNT_CATEGORY_IDS).toEqual([]);
    expect(SELECTABLE_ACCOUNT_CATEGORY_IDS).toEqual([...ACCOUNT_CATEGORY_IDS]);
    expect(ACCOUNT_CATEGORY_IDS.every(isSelectableAccountCategoryId)).toBe(true);
  });

  /**
   * The withdrawal rule, exercised against a FABRICATED retired set.
   *
   * `RETIRED_ACCOUNT_CATEGORY_IDS` is empty, so every one of these assertions
   * would pass vacuously against it — and would keep passing if the rule were
   * deleted outright. Injecting the set is what makes the test able to fail.
   */
  describe('with a withdrawn id', () => {
    const retired: readonly AccountCategoryId[] = ['landlord'];

    it('still VALIDATES a withdrawn id, so a round-trip save works', () => {
      // This is the bug the empty enum would cause: an account that had picked
      // `landlord` PATCHes back what it was served, and every other field it
      // wanted to change goes down with it.
      expect(accountCategoryIdSchema.safeParse('landlord').success).toBe(true);
      expect(accountCategoriesSchema.safeParse(['landlord', 'news']).success).toBe(true);
    });

    it('lets an account KEEP one it already had, in any position', () => {
      expect(newlyAddedRetiredCategories(['landlord'], ['landlord'], retired)).toEqual([]);
      // Re-ordering to promote another category to primary is still a keep.
      expect(
        newlyAddedRetiredCategories(['news', 'landlord'], ['landlord', 'news'], retired)
      ).toEqual([]);
      // Dropping it is always allowed.
      expect(newlyAddedRetiredCategories(['news'], ['landlord'], retired)).toEqual([]);
    });

    it('refuses an account that never had it from ADDING it', () => {
      expect(newlyAddedRetiredCategories(['landlord'], [], retired)).toEqual(['landlord']);
      expect(newlyAddedRetiredCategories(['news', 'landlord'], ['news'], retired)).toEqual([
        'landlord',
      ]);
    });

    it('leaves a live id alone in both directions', () => {
      expect(newlyAddedRetiredCategories(['news'], [], retired)).toEqual([]);
      expect(newlyAddedRetiredCategories(['agency'], ['news'], retired)).toEqual([]);
    });

    it('withdraws it from the picker without touching the vocabulary', () => {
      const selectable = ACCOUNT_CATEGORY_IDS.filter((id) => !retired.includes(id));
      expect(selectable).not.toContain('landlord');
      expect(ACCOUNT_CATEGORY_IDS).toContain('landlord');
    });
  });

  // ---- the wire ------------------------------------------------------------

  it('parses ordered categories on a user response', () => {
    const parsed = userResponseSchema.safeParse({
      id: '507f1f77bcf86cd799439011',
      username: 'acme',
      name: { displayName: 'Acme Realty' },
      accountCategories: ['agency', 'real_estate'],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.accountCategories).toEqual(['agency', 'real_estate']);
    }
  });

  it('omits categories rather than emitting an empty array when there are none', () => {
    const parsed = userResponseSchema.safeParse({
      id: '507f1f77bcf86cd799439011',
      username: 'nate',
      name: { displayName: 'Nate' },
    });
    // Asserted BEFORE the field, so a fixture that fails for an unrelated
    // reason cannot read as "the field was absent" — which is exactly what a
    // `name`-less fixture did on the first run of this test.
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.accountCategories).toBeUndefined();
    }
  });
});
