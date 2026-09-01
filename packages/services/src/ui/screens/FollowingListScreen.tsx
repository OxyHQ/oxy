import type React from 'react';
import type { FollowGraphSort } from '@oxyhq/core';
import type { BaseScreenProps } from '../types/navigation';
import UserListScreen from './UserListScreen';

interface FollowingListScreenProps extends BaseScreenProps {
  userId: string;
  initialCount?: number;
  /** List ordering — see `UserListScreen`. Omitted ⇒ the server default. */
  sort?: FollowGraphSort;
}

const FollowingListScreen: React.FC<FollowingListScreenProps> = (props) => {
  return <UserListScreen {...props} mode="following" />;
};

export default FollowingListScreen;
