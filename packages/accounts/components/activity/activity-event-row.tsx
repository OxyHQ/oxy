import React from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { ThemedText } from '@/components/themed-text';
import { useColors } from '@/hooks/useColors';
import type { SecurityActivity } from '@oxyhq/core';
import type { TranslateFn } from '@/lib/i18n';
import {
    getEventIcon,
    getSeverityColor,
    getEventSeverity,
} from '@/utils/security-utils';
import type { MaterialCommunityIconName } from '@/types/icons';
import { darkenColor } from '@/utils/color-utils';
import {
    getEventSubtitle,
    getEventTitle,
    type DayFormatters,
} from '@/utils/activity-format';
import { ActivityDetailsPanel } from './activity-details-panel';

interface ActivityEventRowProps {
    event: SecurityActivity;
    severityMode: 'light' | 'dark';
    isExpanded: boolean;
    onToggle: (eventId: string) => void;
    isFirst: boolean;
    isLast: boolean;
    formatters: DayFormatters;
    t: TranslateFn;
    onPressIn?: () => void;
}

/**
 * Single activity row with optional expand-to-show-details. The row mimics
 * the visual style of `GroupedItem` (used by `sessions.tsx` et al.) but adds
 * a details panel below the row when tapped.
 */
export function ActivityEventRow({
    event,
    severityMode,
    isExpanded,
    onToggle,
    isFirst,
    isLast,
    formatters,
    t,
    onPressIn,
}: ActivityEventRowProps) {
    const colors = useColors();
    const title = getEventTitle(event, t);
    const subtitle = getEventSubtitle(event, formatters, t);
    const severity = event.severity || getEventSeverity(event.eventType);
    const iconName: MaterialCommunityIconName = getEventIcon(event.eventType);
    const iconColor = getSeverityColor(severity, severityMode);

    const containerStyle = [
        styles.row,
        isFirst && styles.rowFirst,
        isLast && !isExpanded && styles.rowLast,
        {
            backgroundColor: colors.card,
        },
    ];

    const a11yLabel = `${title}, ${subtitle}`;
    const a11yHint = isExpanded
        ? t('a11y.activityCollapse')
        : t('a11y.activityExpand');

    return (
        <View
            style={[
                isFirst && styles.outerFirst,
                isLast && styles.outerLast,
                { backgroundColor: colors.card },
            ]}
        >
            <TouchableOpacity
                style={containerStyle}
                onPressIn={onPressIn}
                onPress={() => onToggle(event.id)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={a11yLabel}
                accessibilityHint={a11yHint}
                accessibilityState={{ expanded: isExpanded }}
            >
                <View
                    style={[styles.iconContainer, { backgroundColor: iconColor }]}
                >
                    <MaterialCommunityIcons
                        name={iconName}
                        size={22}
                        color={darkenColor(iconColor)}
                    />
                </View>
                <View style={styles.textContainer}>
                    <ThemedText
                        style={[styles.rowTitle, { color: colors.text }]}
                        numberOfLines={1}
                    >
                        {title}
                    </ThemedText>
                    <ThemedText
                        style={[
                            styles.rowSubtitle,
                            { color: colors.textSecondary },
                        ]}
                        numberOfLines={2}
                    >
                        {subtitle}
                    </ThemedText>
                </View>
                <MaterialCommunityIcons
                    name={isExpanded ? 'chevron-up' : 'chevron-down'}
                    size={20}
                    color={colors.icon}
                />
            </TouchableOpacity>

            {isExpanded && (
                <ActivityDetailsPanel
                    event={event}
                    formatters={formatters}
                    t={t}
                    isLast={isLast}
                />
            )}

            {!isLast && (
                <View
                    style={[styles.divider, { backgroundColor: colors.border }]}
                />
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    outerFirst: {
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        overflow: 'hidden',
    },
    outerLast: {
        borderBottomLeftRadius: 16,
        borderBottomRightRadius: 16,
        overflow: 'hidden',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 12,
        paddingHorizontal: 12,
        gap: 12,
    },
    rowFirst: {},
    rowLast: {},
    iconContainer: {
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    textContainer: {
        flex: 1,
    },
    rowTitle: {
        fontSize: 15,
        fontWeight: '400',
    },
    rowSubtitle: {
        fontSize: 13,
        marginTop: 2,
    },
    divider: {
        height: StyleSheet.hairlineWidth,
        marginLeft: 60,
        opacity: 0.5,
    },
});
