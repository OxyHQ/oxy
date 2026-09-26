/**
 * The follow button's accessible name follows its state (OxyHQ/oxy#1375 item
 * 22). On @nate's profile the button showed "Following" while TalkBack read
 * "Follow": Bloom names the button by its idle label and leaves the state to
 * the pressed flag, which TalkBack reads as "selected".
 *
 * The table pins what each state says; the render tests pin that both
 * FollowButton modes and FollowTargetButton hand it to Bloom.
 */
import React from 'react';
import { render } from '@testing-library/react';
import {
  describeFollowAllButton,
  describeFollowButton,
  formatHandle,
} from '../followButtonAccessibility';

interface BloomFollowProps {
  following: boolean;
  label?: string;
  followingLabel?: string;
  loading?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}
const mockBloomProps: BloomFollowProps[] = [];
const lastBloomProps = () => mockBloomProps[mockBloomProps.length - 1];

jest.mock('@oxy.so/bloom/media-header', () => ({
  FollowButton: (props: BloomFollowProps) => {
    mockBloomProps.push(props);
    return null;
  },
}));

let mockFollowState = { isFollowing: false, isKnown: true, isLoading: false };
let mockMulti = { allFollowing: false, isAnyLoading: false };
jest.mock('../../hooks/useFollow', () => ({
  useFollowForButton: () => ({
    ...mockFollowState,
    toggleFollow: jest.fn(),
    resolveStatus: jest.fn(),
  }),
  useFollow: () => ({
    ...mockMulti,
    followAllUsers: jest.fn(),
    unfollowAllUsers: jest.fn(),
    fetchAllStatuses: jest.fn(),
  }),
}));

jest.mock('../../context/OxyContext', () => ({
  useOxy: () => ({ oxyServices: {}, canUsePrivateApi: true, user: { id: 'viewer' } }),
}));

let mockTarget = {
  status: { globalState: 'not_following', applicationMode: 'inherit', relationshipId: null },
  isFollowing: false,
  isUnknown: false,
  isPending: false,
};
jest.mock('../../hooks/useFollowTarget', () => ({
  useFollowTarget: () => ({
    ...mockTarget,
    follow: jest.fn(),
    unfollow: jest.fn(),
    disableHere: jest.fn(),
    enableHere: jest.fn(),
  }),
}));

import { FollowButton } from '../FollowButton';
import { FollowTargetButton } from '../FollowTargetButton';

describe('describeFollowButton', () => {
  const known = { isKnown: true, isPending: false, username: 'nate' };

  it.each([
    [{ ...known, isFollowing: true }, 'Following @nate', 'Unfollows @nate'],
    [{ ...known, isFollowing: false }, 'Follow @nate', undefined],
    [{ ...known, isFollowing: true, isPending: true }, 'Following @nate', undefined],
    [{ ...known, isFollowing: false, isPending: true }, 'Follow @nate', undefined],
    [{ ...known, isKnown: false, isFollowing: false }, 'Checking whether you follow @nate', undefined],
    [{ ...known, username: undefined, isFollowing: true }, 'Following', 'Unfollows this account'],
    [{ ...known, username: undefined, isFollowing: false }, 'Follow', undefined],
    [{ ...known, username: undefined, isKnown: false, isFollowing: false }, 'Checking follow status', undefined],
  ])('%o reads "%s"', (input, label, hint) => {
    expect(describeFollowButton(input)).toEqual(
      hint ? { accessibilityLabel: label, accessibilityHint: hint } : { accessibilityLabel: label },
    );
  });

  it('accepts a handle with or without the @', () => {
    expect(formatHandle('@nate')).toBe('@nate');
    expect(formatHandle(' nate ')).toBe('@nate');
    expect(formatHandle('')).toBeUndefined();
    expect(formatHandle(undefined)).toBeUndefined();
  });
});

describe('describeFollowAllButton', () => {
  const labels = { followAllLabel: 'Follow all', followedAllLabel: 'Following' };

  it('names the state and counts the accounts in the hint', () => {
    expect(describeFollowAllButton({ ...labels, allFollowing: false, isPending: false, count: 3 })).toEqual({
      accessibilityLabel: 'Follow all',
      accessibilityHint: 'Follows all 3 accounts',
    });
    expect(describeFollowAllButton({ ...labels, allFollowing: true, isPending: false, count: 1 })).toEqual({
      accessibilityLabel: 'Following',
      accessibilityHint: 'Unfollows all 1 account',
    });
  });

  it('drops the hint while the bulk write is in flight', () => {
    expect(describeFollowAllButton({ ...labels, allFollowing: true, isPending: true, count: 3 })).toEqual({
      accessibilityLabel: 'Following',
    });
  });
});

describe('FollowButton hands Bloom a name that follows the state', () => {
  beforeEach(() => {
    mockBloomProps.length = 0;
  });

  it('reads "Following @nate" while it shows Following', () => {
    mockFollowState = { isFollowing: true, isKnown: true, isLoading: false };
    render(<FollowButton userId="nate-id" username="nate" />);
    expect(lastBloomProps()).toMatchObject({
      following: true,
      accessibilityLabel: 'Following @nate',
      accessibilityHint: 'Unfollows @nate',
    });
  });

  it('reads "Follow @nate" while it shows Follow', () => {
    mockFollowState = { isFollowing: false, isKnown: true, isLoading: false };
    render(<FollowButton userId="nate-id" username="nate" />);
    expect(lastBloomProps()).toMatchObject({ following: false, accessibilityLabel: 'Follow @nate' });
    expect(lastBloomProps()?.accessibilityHint).toBeUndefined();
  });

  it('keeps the shown state while a write is pending', () => {
    mockFollowState = { isFollowing: true, isKnown: true, isLoading: true };
    render(<FollowButton userId="nate-id" username="nate" />);
    expect(lastBloomProps()).toMatchObject({ loading: true, accessibilityLabel: 'Following @nate' });
    expect(lastBloomProps()?.accessibilityHint).toBeUndefined();
  });

  it('says it is checking while the status is unknown', () => {
    mockFollowState = { isFollowing: false, isKnown: false, isLoading: false };
    render(<FollowButton userId="nate-id" username="nate" />);
    expect(lastBloomProps()).toMatchObject({
      loading: true,
      accessibilityLabel: 'Checking whether you follow @nate',
    });
  });

  it('names the "Follow all" button by its state too', () => {
    mockMulti = { allFollowing: true, isAnyLoading: false };
    render(<FollowButton userIds={['a', 'b']} />);
    expect(lastBloomProps()).toMatchObject({
      following: true,
      accessibilityLabel: 'Following',
      accessibilityHint: 'Unfollows all 2 accounts',
    });
  });
});

describe('FollowTargetButton names the state it shows', () => {
  beforeEach(() => {
    mockBloomProps.length = 0;
  });

  it.each([
    ['following', { globalState: 'following', applicationMode: 'inherit' }, true, 'Following'],
    ['requested', { globalState: 'requested', applicationMode: 'inherit' }, true, 'Requested'],
    ['off here', { globalState: 'following', applicationMode: 'disabled' }, true, 'Off here'],
    ['not following', { globalState: 'not_following', applicationMode: 'inherit' }, false, 'Follow'],
  ])('%s', (_name, status, isFollowing, label) => {
    mockTarget = {
      status: { ...status, relationshipId: null },
      isFollowing,
      isUnknown: false,
      isPending: false,
    };
    render(<FollowTargetButton targetId="t1" showOptions={false} />);
    expect(lastBloomProps()?.accessibilityLabel).toBe(label);
  });
});
