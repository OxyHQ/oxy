import type React from 'react';
import type { FollowGraphSort } from '@oxyhq/core';
import type { BaseScreenProps } from '../types/navigation';
import UserListScreen from './UserListScreen';

interface FollowersListScreenProps extends BaseScreenProps {
  userId: string;
  initialCount?: number;
  /** List ordering — see `UserListScreen`. Omitted ⇒ the server default. */
  sort?: FollowGraphSort;
}

const FollowersListScreen: React.FC<FollowersListScreenProps> = (props) => {
  return <UserListScreen {...props} mode="followers" />;
};

export default FollowersListScreen;
