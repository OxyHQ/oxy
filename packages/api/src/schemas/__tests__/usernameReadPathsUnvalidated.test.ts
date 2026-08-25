/**
 * The username policy is a WRITE rule. Pointing it at a READ turns an account
 * that already exists into a 400 — or a 500 — and this is the test that says so
 * out loud.
 *
 * ## Why it is not obvious
 *
 * `usernameSchema` is now imported by nine write paths, and the read schemas
 * beside them still carry hand-written bounds. Making those bounds "consistent"
 * looks like exactly the tidying-up this whole change is about, and it is the
 * opposite: the rows a read has to serve were written under earlier rules, and
 * one of them is not even the same namespace.
 *
 * ## What production actually holds (measured 2026-08-25)
 *
 *  - **73,146 federated rows** whose `username` is `handle@domain` — 100 % carry
 *    an `@`, 7,152 are longer than 30 characters, the longest is 83. Every one of
 *    them fails `usernameSchema`, correctly: they belong to other servers.
 *  - **11 local rows with no username at all**, still `active`.
 *  - **4 hyphenated accounts** and **one with a capital letter**.
 *
 * `GET /profiles/username/:username` serves all of those. Its param schema must
 * stay looser than the policy, and this test fails if somebody narrows it.
 */

import { checkUsernameParams } from '../auth.schemas';
import { usernameParams } from '../profiles.schemas';

/** Handles taken verbatim from the production census. */
const FEDERATED_HANDLES = [
  'alice@mastodon.social',
  '0cix_revoluti0ns@mastodon.bida.im',
  '1bitsquaredstoreusa@social.1bitsquared.com',
  // The longest federated handle in the table, at 83 characters, is this shape.
  `${'a'.repeat(40)}@${'b'.repeat(21)}.example`,
];

/** Local names that exist and must keep resolving. */
const EXISTING_LOCAL_NAMES = ['nate', 'oxy', 'Viacheslav', 'community-maestro', 'alia-production-chat'];

describe('the profile read path is NOT held to the write policy', () => {
  it.each(FEDERATED_HANDLES)('resolves the federated handle %s', (handle) => {
    expect(usernameParams.safeParse({ username: handle }).success).toBe(true);
  });

  it.each(EXISTING_LOCAL_NAMES)('resolves the existing account %s', (username) => {
    expect(usernameParams.safeParse({ username }).success).toBe(true);
  });

  /**
   * The positive control for the two blocks above: if `usernameParams` had been
   * narrowed to the policy, every federated handle would fail. Asserting the
   * policy REJECTS them is what proves the assertions above are load-bearing
   * rather than passing because everything passes.
   */
  it('and the write policy would reject every one of those federated handles', async () => {
    const { usernameSchema } = await import('@oxyhq/contracts');
    for (const handle of FEDERATED_HANDLES) {
      expect(usernameSchema.safeParse(handle).success).toBe(false);
    }
  });
});

describe('the availability check IS held to the write policy', () => {
  /**
   * The one read that applies the write rule, deliberately: it answers "may I
   * have this name?", so it must answer with the rule that decides. It judges the
   * string being ASKED FOR, never a stored row.
   */
  it('accepts a name that could be claimed', () => {
    expect(checkUsernameParams.safeParse({ username: 'my-new-bot' }).success).toBe(true);
  });

  it.each(['al ice', 'my.bot', '-alice', 'ab', 'a'.repeat(31)])(
    'refuses to call %s available, because the write would refuse it',
    (username) => {
      expect(checkUsernameParams.safeParse({ username }).success).toBe(false);
    }
  );
});
