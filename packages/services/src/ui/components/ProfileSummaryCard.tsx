import type React from 'react';
import { View } from 'react-native';
import { Avatar } from '@oxy.so/bloom/avatar';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import AvatarCameraBadge from './AvatarCameraBadge';

/** Shared identity row; Bloom owns its material, geometry and full-row interaction. */
export interface ProfileSummaryCardProps {
  /** Primary display name shown beside the avatar. */
  displayName: string;
  /** Resolved avatar thumbnail URL (undefined → initials fallback). */
  avatarUri?: string;
  /** Avatar diameter in px. Defaults to 56. */
  avatarSize?: number;
  /**
   * Secondary lines rendered beneath the name (e.g. `@handle`, email).
   * Falsy entries are skipped so callers can pass conditional values inline.
   */
  lines?: Array<string | null | undefined | false>;
  /** When provided, the summary row is pressable (e.g. opens the avatar picker). */
  onAvatarPress?: () => void;
  /** Render the camera badge overlay. Only meaningful with `onAvatarPress`. */
  showCameraBadge?: boolean;
  /** Accessibility label for the pressable avatar. */
  avatarAccessibilityLabel?: string;
}

const ProfileSummaryCard: React.FC<ProfileSummaryCardProps> = ({
  displayName,
  avatarUri,
  avatarSize = 56,
  lines,
  onAvatarPress,
  showCameraBadge = false,
  avatarAccessibilityLabel,
}) => (
  <GroupedSection style={{ marginBottom: 16 }}>
    <GroupedSectionItem
      icon={
        <View style={{ position: 'relative' }}>
          <Avatar source={avatarUri} name={displayName} size={avatarSize} />
          {onAvatarPress && showCameraBadge ? <AvatarCameraBadge /> : null}
        </View>
      }
      title={displayName}
      description={
        (lines ?? [])
          .filter((line): line is string => typeof line === 'string' && line.length > 0)
          .join('\n') || undefined
      }
      onPress={onAvatarPress}
      accessibilityLabel={onAvatarPress ? avatarAccessibilityLabel : undefined}
      showChevron={false}
    />
  </GroupedSection>
);

export default ProfileSummaryCard;
