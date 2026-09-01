import React, { memo, useMemo, type ComponentProps } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useHapticPress } from '@/hooks/use-haptic-press';
import { darkenColor } from '@/utils/colorUtils';
import { normalizeColorScheme } from '@/utils/themeUtils';
import { Colors } from '@/constants/theme';

export type IoniconName = ComponentProps<typeof Ionicons>['name'];

interface GroupedItemProps {
    icon?: IoniconName;
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
    const hookColorScheme = useColorScheme();
    const colorScheme = normalizeColorScheme(hookColorScheme);
    const colors = Colors[colorScheme];
    // Use fallback color when iconColor is not provided
    const finalIconColor = iconColor || colors.iconSecurity;

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
                    <Ionicons name={icon} size={22} color={darkenColor(finalIconColor)} />
                </View>
            ) : null}
            <View style={styles.actionTextContainer}>
                <Text style={[styles.actionButtonText, { color: colors.text }]}>{title}</Text>
                {subtitle && (
                    <Text style={[styles.actionButtonSubtext, { color: colors.secondaryText }]}>
                        {subtitle}
                    </Text>
                )}
            </View>
            {customContent}
            {showChevron && (
                <Ionicons name="chevron-forward" size={20} color={colors.icon} />
            )}
        </View>
    );

    const handlePressIn = useHapticPress();

    if (onPress && !disabled) {
        return (
            <TouchableOpacity
                style={itemStyles}
                onPressIn={disabled ? undefined : handlePressIn}
                onPress={onPress}
                activeOpacity={0.7}
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
        borderTopLeftRadius: 18,
        borderTopRightRadius: 18,
    },
    lastGroupedItem: {
        borderBottomLeftRadius: 18,
        borderBottomRightRadius: 18,
    },
    groupedItemContent: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 8,
        paddingHorizontal: 10,
        width: '100%',
        gap: 10,
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
        fontSize: 14,
        fontWeight: '400',
    },
    actionButtonSubtext: {
        fontSize: 12,
        marginTop: 2,
    },
});

export default GroupedItem;



