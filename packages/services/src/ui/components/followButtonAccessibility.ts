/**
 * What a screen reader hears for a follow button.
 *
 * Bloom's `FollowButton` names itself "Follow" in both states and carries the
 * state in its pressed flag. Android TalkBack reads that flag as "selected",
 * so a button that SHOWS "Following" was announced as "Follow, selected", and a
 * TalkBack user could not tell they already follow the account
 * (OxyHQ/oxy#1375 item 22). The name now says the state, and who it is for
 * when the caller knows the handle.
 *
 * Pure, and kept apart from the components, so every state is pinned by a
 * table test rather than by a render that can only see one state at a time.
 */

export interface FollowButtonAccessibility {
  accessibilityLabel: string;
  accessibilityHint?: string;
}

/** `@nate` from `nate` or `@nate`; `undefined` when there is no handle. */
export function formatHandle(username: string | undefined): string | undefined {
  const bare = username?.trim().replace(/^@+/, '');
  return bare ? `@${bare}` : undefined;
}

/**
 * The single-user button.
 *
 * - `isKnown: false`: the status is still being fetched and the button is
 *   inert, so it says so rather than offering a "Follow" it would ignore.
 * - `isPending`: a follow or unfollow is in flight. The name keeps the state
 *   the button still shows; the busy flag says the rest, and there is no hint
 *   because a press does nothing until the write settles.
 * - Following: "Following @nate", hinted "Unfollows @nate", because pressing
 *   it unfollows, which the visible "Following" does not say.
 */
export function describeFollowButton(input: {
  isKnown: boolean;
  isFollowing: boolean;
  isPending: boolean;
  username?: string;
}): FollowButtonAccessibility {
  const handle = formatHandle(input.username);

  if (!input.isKnown) {
    return {
      accessibilityLabel: handle
        ? `Checking whether you follow ${handle}`
        : 'Checking follow status',
    };
  }

  const accessibilityLabel = input.isFollowing
    ? handle ? `Following ${handle}` : 'Following'
    : handle ? `Follow ${handle}` : 'Follow';

  if (input.isPending || !input.isFollowing) return { accessibilityLabel };

  return {
    accessibilityLabel,
    accessibilityHint: handle ? `Unfollows ${handle}` : 'Unfollows this account',
  };
}

/**
 * The "Follow all" button. The labels are the caller's, since a starter pack
 * and a feed's member list word it differently; the hint carries the count.
 */
export function describeFollowAllButton(input: {
  allFollowing: boolean;
  isPending: boolean;
  count: number;
  followAllLabel: string;
  followedAllLabel: string;
}): FollowButtonAccessibility {
  const accessibilityLabel = input.allFollowing ? input.followedAllLabel : input.followAllLabel;
  if (input.isPending) return { accessibilityLabel };
  const accounts = input.count === 1 ? '1 account' : `${input.count} accounts`;
  return {
    accessibilityLabel,
    accessibilityHint: input.allFollowing ? `Unfollows all ${accounts}` : `Follows all ${accounts}`,
  };
}
