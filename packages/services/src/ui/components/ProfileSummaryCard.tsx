import type React from 'react';
import { View, type ViewStyle } from 'react-native';
import { H4, Text } from '@oxy.so/bloom/typography';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Card } from '@oxy.so/bloom/card';
import { PressableScale } from '@oxy.so/bloom/pressable-scale';
import AvatarCameraBadge from './AvatarCameraBadge';

/**
 * ProfileSummaryCard — the shared "who am I" summary block rendered at the top
 * of {@link ManageAccountScreen} and {@link EditProfileScreen}.
 *
 * A Bloom filled {@link Card} containing a centered {@link Avatar}, the display
 * name and any number of secondary lines (handle, email, …). When
 * `onAvatarPress` is supplied the avatar becomes a {@link PressableScale} entry
 * point (used to open the avatar picker) and can render an optional camera
 * badge overlay.
 */
export interface ProfileSummaryCardProps {
    /** Primary display name shown under the avatar. */
    displayName: string;
    /** Resolved avatar thumbnail URL (undefined → initials fallback). */
    avatarUri?: string;
    /** Avatar diameter in px. Defaults to 72. */
    avatarSize?: number;
    /**
     * Secondary lines rendered beneath the name (e.g. `@handle`, email).
     * Falsy entries are skipped so callers can pass conditional values inline.
     */
    lines?: Array<string | null | undefined | false>;
    /** When provided, the avatar is pressable (e.g. opens the avatar picker). */
    onAvatarPress?: () => void;
    /** Render the camera badge overlay. Only meaningful with `onAvatarPress`. */
    showCameraBadge?: boolean;
    /** Accessibility label for the pressable avatar. */
    avatarAccessibilityLabel?: string;
}

const cardStyle: ViewStyle = {
    borderRadius: 20,
    marginBottom: 16,
};

const pressableStyle: ViewStyle = {
    position: 'relative',
};

const ProfileSummaryCard: React.FC<ProfileSummaryCardProps> = ({
    displayName,
    avatarUri,
    avatarSize = 72,
    lines,
    onAvatarPress,
    showCameraBadge = false,
    avatarAccessibilityLabel,
}) => {
    const avatar = <Avatar source={avatarUri} name={displayName} size={avatarSize} />;

    const avatarNode = onAvatarPress ? (
        <PressableScale
            onPress={onAvatarPress}
            accessibilityRole="button"
            accessibilityLabel={avatarAccessibilityLabel}
            style={pressableStyle}
            className="mb-space-12"
        >
            {avatar}
            {showCameraBadge ? <AvatarCameraBadge /> : null}
        </PressableScale>
    ) : (
        <View className="mb-space-12">{avatar}</View>
    );

    const subtitleLines = (lines ?? []).filter(
        (line): line is string => typeof line === 'string' && line.length > 0,
    );

    return (
        <Card variant="filled" style={cardStyle}>
            <View className="items-center px-space-20 py-space-24">
                {avatarNode}
                <H4 className="text-text" numberOfLines={1}>
                    {displayName}
                </H4>
                {subtitleLines.map((line, index) => (
                    <Text
                        // Subtitle order is stable within a render; index keys are safe here.
                        key={`${index}-${line}`}
                        className="text-text-secondary text-sm mt-space-2"
                        numberOfLines={1}
                    >
                        {line}
                    </Text>
                ))}
            </View>
        </Card>
    );
};

export default ProfileSummaryCard;
