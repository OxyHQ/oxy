import React, { memo, useMemo } from 'react';
import { AppIcon, Icons } from '@/constants/icons';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useHapticPress } from '@/hooks/use-haptic-press';
import { darkenColor } from '@/utils/color-utils';
import type { IconName } from '@/constants/icons';

interface GroupedItemProps {
    icon?: IconName;
    iconColor?: string;
    title: string;
    subtitle?: string;
    onPress?: () => void;
    isFirst?: boolean;
    isLast?: boolean;
    showChevron?: boolean;
    disabled?: boolean;
    customContent?: React.ReactNode;
    customIcon?: React.ReactNode;
}

const GroupedItemComponent = ({
    icon,
    iconColor,
    title,
    subtitle,
    onPress,
    isFirst = false,
    isLast = false,
    showChevron = false,
    disabled = false,
    customContent,
    customIcon,
}: GroupedItemProps) => {
    const colors = useColors();
    // Use fallback color when iconColor is not provided
    const finalIconColor = iconColor ?? colors.sidebarIconSecurity;

    const itemStyles = useMemo(
        () => [
            styles.groupedItem,
            isFirst && styles.firstGroupedItem,
            isLast && styles.lastGroupedItem,
            {
                backgroundColor: colors.card,
            },
        ],
        [colors.card, isFirst, isLast],
    );

    const content = (
        <View style={styles.groupedItemContent}>
            {customIcon ? (
                <View style={styles.actionIcon}>{customIcon}</View>
            ) : icon ? (
                <View style={[styles.iconContainer, { backgroundColor: finalIconColor }]}>
                    <AppIcon name={icon} size='md' fill={darkenColor(finalIconColor)} />
                </View>
            ) : null}
            <View style={styles.actionTextContainer}>
                <Text style={[styles.actionButtonText, { color: colors.text }]}>{title}</Text>
                {subtitle && (
                    <Text style={[styles.actionButtonSubtext, { color: colors.textSecondary }]}>
                        {subtitle}
                    </Text>
                )}
            </View>
            {customContent}
            {showChevron && (
                <Icons.forward size='md' fill={colors.icon} />
            )}
        </View>
    );

    const handlePressIn = useHapticPress();

    if (onPress && !disabled) {
        const a11yLabel = subtitle ? `${title}, ${subtitle}` : title;
        return (
            <TouchableOpacity
                style={itemStyles}
                onPressIn={disabled ? undefined : handlePressIn}
                onPress={onPress}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={a11yLabel}
                accessibilityState={{ disabled }}
            >
                {content}
            </TouchableOpacity>
        );
    }

    return <View style={itemStyles}>{content}</View>;
};

GroupedItemComponent.displayName = 'GroupedItem';

export const GroupedItem = memo(GroupedItemComponent);

const styles = StyleSheet.create({
    groupedItem: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        overflow: 'hidden',
        width: '100%',
    },
    firstGroupedItem: {
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
    },
    lastGroupedItem: {
        borderBottomLeftRadius: 12,
        borderBottomRightRadius: 12,
    },
    groupedItemContent: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 12,
        paddingHorizontal: 12,
        width: '100%',
        gap: 12,
    },
    actionIcon: {
        // marginRight handled by gap
    },
    iconContainer: {
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        // marginRight handled by gap
    },
    actionTextContainer: {
        flex: 1,
    },
    actionButtonText: {
        fontSize: 15,
        fontWeight: '400',
    },
    actionButtonSubtext: {
        fontSize: 13,
        marginTop: 2,
    },
});
