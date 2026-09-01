import type React from 'react';
import type { ViewStyle } from 'react-native';
import { View } from 'react-native-css/components';
import Ionicons from '../icons/Ionicons';
import { useTheme } from '@oxyhq/bloom/theme';

/**
 * The camera overlay badge on a pressable avatar — the "tap to change your
 * photo" affordance. Shared verbatim by {@link ProfileSummaryCard} (ManageAccount
 * / EditProfile) and the account-menu hero avatar (`AccountsView`), so the badge
 * reads identically everywhere. Renders as an absolutely-positioned bottom-right
 * overlay; the caller wraps it (with the avatar) in a `position: relative`
 * pressable.
 */
const badgeStyle: ViewStyle = {
  position: 'absolute',
  right: 0,
  bottom: 0,
  width: 28,
  height: 28,
  borderRadius: 14,
  alignItems: 'center',
  justifyContent: 'center',
  borderWidth: 2,
};

const AvatarCameraBadge: React.FC = () => {
  const theme = useTheme();
  return (
    <View style={badgeStyle} className="bg-fill-brand border-border-image">
      <Ionicons name="camera" size={14} color={theme.colors.primaryForeground} />
    </View>
  );
};

export default AvatarCameraBadge;
