import React from 'react';
import { View, StyleSheet } from 'react-native';
import { ThemedText } from '@/components/themed-text';
import { useColors } from '@/hooks/useColors';
import type { SecurityActivity } from '@oxy.so/core';
import type { TranslateFn } from '@/lib/i18n';
import type { DayFormatters } from '@/utils/activity-format';

interface ActivityDetailsPanelProps {
    event: SecurityActivity;
    formatters: DayFormatters;
    t: TranslateFn;
    isLast: boolean;
}

interface DetailRow {
    key: string;
    label: string;
    value: string;
}

/**
 * Expanded detail panel rendered below an activity row. Lists known
 * metadata fields as key/value pairs.
 */
export function ActivityDetailsPanel({
    event,
    formatters,
    t,
    isLast,
}: ActivityDetailsPanelProps) {
    const colors = useColors();
    const timestamp = new Date(event.timestamp);
    const validTimestamp = !Number.isNaN(timestamp.getTime());

    const rows: DetailRow[] = [];

    rows.push({
        key: 'type',
        label: t('activity.details.type'),
        value: event.eventType,
    });
    rows.push({
        key: 'severity',
        label: t('activity.details.severity'),
        value: event.severity,
    });
    if (validTimestamp) {
        rows.push({
            key: 'time',
            label: t('activity.details.time'),
            value: `${formatters.longDay.format(
                timestamp,
            )} — ${formatters.time.format(timestamp)}`,
        });
    }
    if (event.userAgent) {
        rows.push({
            key: 'ua',
            label: t('activity.details.browser'),
            value: event.userAgent,
        });
    }
    if (event.deviceId) {
        rows.push({
            key: 'deviceId',
            label: t('activity.details.deviceId'),
            value: event.deviceId,
        });
    }
    if (event.metadata && typeof event.metadata === 'object') {
        const metadata = event.metadata as Record<string, unknown>;
        for (const [k, v] of Object.entries(metadata)) {
            if (v === null || v === undefined) continue;
            const display =
                typeof v === 'string'
                    ? v
                    : typeof v === 'number' || typeof v === 'boolean'
                      ? String(v)
                      : JSON.stringify(v);
            rows.push({ key: `meta-${k}`, label: k, value: display });
        }
    }

    return (
        <View
            style={[
                styles.detailsPanel,
                isLast && styles.detailsPanelLast,
                { backgroundColor: colors.card },
            ]}
            accessibilityLabel={t('a11y.activityDetails')}
        >
            {rows.map((row) => (
                <View key={row.key} style={styles.detailRow}>
                    <ThemedText
                        style={[
                            styles.detailLabel,
                            { color: colors.textSecondary },
                        ]}
                    >
                        {row.label}
                    </ThemedText>
                    <ThemedText
                        style={[styles.detailValue, { color: colors.text }]}
                        numberOfLines={3}
                    >
                        {row.value}
                    </ThemedText>
                </View>
            ))}
        </View>
    );
}

const styles = StyleSheet.create({
    detailsPanel: {
        paddingHorizontal: 16,
        paddingTop: 4,
        paddingBottom: 16,
        gap: 10,
    },
    detailsPanelLast: {},
    detailRow: {
        flexDirection: 'column',
        gap: 2,
    },
    detailLabel: {
        fontSize: 12,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
    },
    detailValue: {
        fontSize: 14,
    },
});
