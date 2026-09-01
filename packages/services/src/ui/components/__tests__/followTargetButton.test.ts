/**
 * The follow button's product decisions, as a table.
 *
 * `buildFollowMenuItems` is pure and tested here rather than through a render
 * because what matters is WHICH choices exist in which state — an assertion a
 * rendering test would make about the DOM, one layout change away from being
 * about nothing.
 *
 * `withApplicationMode` sits beside it because the two have to agree: the menu
 * offers "don't show here", and the store computes what that does to the
 * effective state. If they disagree the button offers something it then fails
 * to reflect.
 */

import {
  buildFollowMenuItems,
  FOLLOW_ACTION_LEAVES_ACTIVE,
  resolveFollowPrimaryAction,
} from '../FollowTargetButton';
import {
  isCompleteFollowStatus,
  followRecordToStatus,
  followRecordsToStatusMap,
  isFollowedGlobally,
  UNKNOWN_FOLLOW_STATUS,
  withApplicationMode,
} from '../../stores/followTargetStore';

const DURATIONS = [
  { label: '24 hours', seconds: 86400 },
  { label: 'A week', seconds: 604800 },
];

const base = {
  following: false,
  applicationMode: 'inherit' as const,
  hasRelationship: false,
  isPending: false,
  durations: DURATIONS,
  idleVerb: 'Follow',
  applicationName: 'Mention',
};

const keys = (items: ReturnType<typeof buildFollowMenuItems>) => items.map((i) => i.key);

describe('resolveFollowPrimaryAction', () => {
  it('follows when not following globally', () => {
    expect(resolveFollowPrimaryAction({ isFollowing: false, applicationMode: 'inherit' })).toBe(
      'follow'
    );
  });

  it('unfollows when following and active here', () => {
    expect(resolveFollowPrimaryAction({ isFollowing: true, applicationMode: 'inherit' })).toBe(
      'unfollow'
    );
  });

  it('re-enables here instead of unfollowing everywhere when switched off in this app', () => {
    expect(resolveFollowPrimaryAction({ isFollowing: true, applicationMode: 'disabled' })).toBe(
      'enable-here'
    );
  });
});

describe('buildFollowMenuItems', () => {
  describe('before following', () => {
    it('offers the timed follows and nothing else', () => {
      const items = buildFollowMenuItems(base);
      expect(keys(items)).toEqual(['for-86400', 'for-604800']);
      // Nothing that addresses a relationship, because there is none.
      expect(keys(items).some((k) => k.includes('unfollow') || k.includes('here'))).toBe(false);
    });

    it('phrases the option with the application’s own verb', () => {
      expect(buildFollowMenuItems({ ...base, idleVerb: 'Subscribe' })[0].label).toBe(
        'Subscribe for 24 hours'
      );
    });

    it('offers nothing when the application turned timed follows off', () => {
      expect(buildFollowMenuItems({ ...base, durations: false })).toEqual([]);
    });
  });

  describe('while following', () => {
    const following = { ...base, following: true, hasRelationship: true };

    it('offers turning it off here, and unfollowing everywhere', () => {
      expect(keys(buildFollowMenuItems(following))).toEqual([
        'disable-here',
        'unfollow-everywhere',
      ]);
    });

    it('names the application, so the line is a sentence the user can act on', () => {
      expect(buildFollowMenuItems(following)[0].label).toBe('Don’t show in Mention');
    });

    it('offers turning it back on once it is off here', () => {
      const items = buildFollowMenuItems({ ...following, applicationMode: 'disabled' });
      expect(keys(items)).toEqual(['enable-here', 'unfollow-everywhere']);
      expect(items[0].label).toBe('Show in Mention');
    });

    it('never offers a timed follow', () => {
      // Extending a follow is a different operation from starting one, and
      // offering "Follow for 24 hours" to somebody already following would read
      // as shortening it.
      expect(keys(buildFollowMenuItems(following)).some((k) => k.startsWith('for-'))).toBe(false);
    });

    it('offers nothing while a write is in flight', () => {
      // Every entry addresses the relationship id, which an optimistic follow
      // does not have yet. Offering them here would mean sending a guess.
      expect(buildFollowMenuItems({ ...following, isPending: true })).toEqual([]);
    });

    it('offers nothing when the relationship id is not known', () => {
      expect(buildFollowMenuItems({ ...following, hasRelationship: false })).toEqual([]);
    });
  });
});

describe('withApplicationMode', () => {
  const active = { ...UNKNOWN_FOLLOW_STATUS, globalState: 'active' as const };

  it('makes a disabled follow inactive without giving up the follow', () => {
    const next = withApplicationMode(active, 'disabled');
    expect(next.effectiveState).toBe('not_following');
    // The distinction the whole design exists for, and the reason a client must
    // never read `effectiveState` as "does the user follow this": the follow is
    // still there globally.
    expect(next.globalState).toBe('active');
    expect(isFollowedGlobally(next)).toBe(true);
  });

  it('restores inheritance when enabled again', () => {
    expect(withApplicationMode(withApplicationMode(active, 'disabled'), 'inherit')).toMatchObject({
      applicationMode: 'inherit',
      effectiveState: 'following',
    });
  });

  it('keeps a requested follow requested rather than promoting it', () => {
    const requested = { ...active, globalState: 'requested' as const };
    expect(withApplicationMode(requested, 'enabled').effectiveState).toBe('requested');
    // And a request in flight still counts as following, so the button offers
    // to cancel rather than to ask again.
    expect(isFollowedGlobally(requested)).toBe(true);
  });

  it('stays not-following when there is no global relationship to act on', () => {
    expect(withApplicationMode(UNKNOWN_FOLLOW_STATUS, 'enabled').effectiveState).toBe(
      'not_following'
    );
    expect(isFollowedGlobally(UNKNOWN_FOLLOW_STATUS)).toBe(false);
  });

  it('treats a following row without relationshipId as incomplete', () => {
    expect(
      isCompleteFollowStatus({
        globalState: 'active',
        applicationMode: 'inherit',
        effectiveState: 'following',
      })
    ).toBe(false);
    expect(isCompleteFollowStatus(UNKNOWN_FOLLOW_STATUS)).toBe(true);
  });

  it('converts a list row into a complete follow status', () => {
    const status = followRecordToStatus({
      relationshipId: 'rel-1',
      target: { id: 'tgt-1', uri: 'https://example.test/t/1', kind: 'oxy.topic' },
      globalState: 'active',
      applicationMode: 'inherit',
      effectiveState: 'following',
      originApplicationId: 'app-a',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(status).toEqual({
      relationshipId: 'rel-1',
      globalState: 'active',
      applicationMode: 'inherit',
      effectiveState: 'following',
    });
    expect(isCompleteFollowStatus(status)).toBe(true);
    expect(followRecordsToStatusMap([
      {
        relationshipId: 'rel-1',
        target: { id: 'tgt-1', uri: 'https://example.test/t/1', kind: 'oxy.topic' },
        globalState: 'active',
        applicationMode: 'disabled',
        effectiveState: 'not_following',
        originApplicationId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ])).toEqual({
      'tgt-1': {
        relationshipId: 'rel-1',
        globalState: 'active',
        applicationMode: 'disabled',
        effectiveState: 'not_following',
      },
    });
  });
});

describe('what onChange reports', () => {
  // The bug: the same action reached from the primary button and from the menu
  // reported differently. Someone picking "Don't show in Syra" kept the artist
  // on Syra's own shelf and kept feeding its taste signal — the exact state
  // that menu item exists to end.
  //
  // Both controls now read one table, so the two cannot drift apart again.
  // These tests pin what the table SAYS; the `Record` type is what stops a new
  // action from being omitted.

  it('reports the EFFECTIVE state — does this app act on it now', () => {
    expect(FOLLOW_ACTION_LEAVES_ACTIVE).toEqual({
      follow: true,
      'follow-timed': true,
      'enable-here': true,
      'disable-here': false,
      unfollow: false,
    });
  });

  it('treats enable-here as active even though the global follow did not change', () => {
    // The distinction that decides the whole question: a mirror is asking
    // "should this appear in MY app", not "does the user follow it anywhere".
    expect(FOLLOW_ACTION_LEAVES_ACTIVE['enable-here']).toBe(true);
    expect(FOLLOW_ACTION_LEAVES_ACTIVE['disable-here']).toBe(false);
  });

  it('covers every action either control can produce', () => {
    // A menu item whose action is missing from the table would report
    // `undefined` — falsy, so it would silently read as "not active here".
    const fromMenu = new Set(
      [
        ...buildFollowMenuItems({ ...base }),
        ...buildFollowMenuItems({ ...base, following: true, hasRelationship: true }),
        ...buildFollowMenuItems({
          ...base,
          following: true,
          hasRelationship: true,
          applicationMode: 'disabled',
        }),
      ].map((item) => item.action.type)
    );
    // Plus the two the primary button can produce that the menu cannot.
    for (const action of [...fromMenu, 'follow', 'unfollow']) {
      expect(typeof FOLLOW_ACTION_LEAVES_ACTIVE[action as keyof typeof FOLLOW_ACTION_LEAVES_ACTIVE])
        .toBe('boolean');
    }
    expect(fromMenu.size).toBeGreaterThanOrEqual(3);
  });
});
