import { render, screen } from '@testing-library/react';
import { FollowTargetButton } from '../../src/ui/components/FollowTargetButton';

let status = { globalState: 'requested', applicationMode: 'inherit', relationshipId: 'request' };
let isFollowing = false;
jest.mock('../../src/ui/hooks/useFollowTarget', () => ({ useFollowTarget: () => ({
  status, isFollowing, isUnknown: false, isPending: false,
  follow: jest.fn(), unfollow: jest.fn(), disableHere: jest.fn(), enableHere: jest.fn(),
}) }));

it('preserves the requested label before the relationship is accepted', () => {
  render(<FollowTargetButton targetId="private-account" showOptions={false} />);
  expect(screen.getByRole('button').textContent).toBe('Requested');
});

it('preserves the application-disabled label for a global follow', () => {
  status = { globalState: 'following', applicationMode: 'disabled', relationshipId: 'follow' };
  isFollowing = true;
  render(<FollowTargetButton targetId="topic" showOptions={false} />);
  expect(screen.getByRole('button').textContent).toBe('Off here');
});
