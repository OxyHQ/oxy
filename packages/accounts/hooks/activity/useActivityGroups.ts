import { useMemo } from 'react';
import { useInfiniteSecurityActivity } from '@oxy.so/services';
import type { SecurityActivity } from '@oxy.so/core';
import { useTranslation } from '@/lib/i18n';
import {
    getGroupKey,
    groupKeyToId,
    type DayFormatters,
    type GroupKey,
} from '@/utils/activity-format';

/** Page size for the infinite query. */
const PAGE_SIZE = 30;

/** Stable Intl date formatters keyed by locale. */
function useDayFormatters(locale: string): DayFormatters {
    return useMemo(
        () => ({
            longDay: new Intl.DateTimeFormat(locale, {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                year: 'numeric',
            }),
            shortDay: new Intl.DateTimeFormat(locale, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
            }),
            time: new Intl.DateTimeFormat(locale, {
                hour: 'numeric',
                minute: '2-digit',
            }),
            relative:
                typeof Intl !== 'undefined' &&
                typeof Intl.RelativeTimeFormat === 'function'
                    ? new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
                    : null,
        }),
        [locale],
    );
}

export interface ActivityGroup {
    key: GroupKey;
    id: string;
    title: string;
    activities: SecurityActivity[];
}

export interface UseActivityGroupsResult {
    groups: ActivityGroup[];
    activities: SecurityActivity[];
    formatters: DayFormatters;
    isLoading: boolean;
    isError: boolean;
    error: Error | null;
    fetchNextPage: () => void;
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    refetch: () => Promise<unknown>;
}

/**
 * Loads paginated security activity, flattens the infinite-query pages, and
 * buckets the events into Google-style day groups ready for rendering.
 *
 * Extracted verbatim from the activity screen's inline query + memos; the
 * grouping preserves server order within and across buckets.
 */
export function useActivityGroups(): UseActivityGroupsResult {
    const { t, locale } = useTranslation();
    const formatters = useDayFormatters(locale);

    const {
        data,
        isLoading,
        isError,
        error,
        fetchNextPage,
        hasNextPage,
        isFetchingNextPage,
        refetch,
    } = useInfiniteSecurityActivity({
        limit: PAGE_SIZE,
    });

    const activities = useMemo<SecurityActivity[]>(() => {
        if (!data?.pages) return [];
        const all: SecurityActivity[] = [];
        for (const page of data.pages) {
            for (const event of page.data) {
                all.push(event);
            }
        }
        return all;
    }, [data]);

    /** Group sorted activities by day bucket, preserving server order. */
    const groups = useMemo<ActivityGroup[]>(() => {
        if (activities.length === 0) return [];
        const now = new Date();
        const buckets = new Map<string, ActivityGroup>();
        const order: string[] = [];

        for (const event of activities) {
            const date = new Date(event.timestamp);
            if (Number.isNaN(date.getTime())) continue;
            const key = getGroupKey(date, now);
            const id = groupKeyToId(key);

            let bucket = buckets.get(id);
            if (!bucket) {
                let title: string;
                if (key.kind === 'today') {
                    title = t('activity.groups.today');
                } else if (key.kind === 'yesterday') {
                    title = t('activity.groups.yesterday');
                } else if (key.kind === 'last7Days') {
                    title = t('activity.groups.last7Days');
                } else {
                    title = formatters.longDay.format(date);
                }
                bucket = { key, id, title, activities: [] };
                buckets.set(id, bucket);
                order.push(id);
            }
            bucket.activities.push(event);
        }

        const result: ActivityGroup[] = [];
        for (const id of order) {
            const bucket = buckets.get(id);
            if (bucket) result.push(bucket);
        }
        return result;
    }, [activities, formatters, t]);

    return {
        groups,
        activities,
        formatters,
        isLoading,
        isError,
        error,
        fetchNextPage,
        hasNextPage,
        isFetchingNextPage,
        refetch,
    };
}
