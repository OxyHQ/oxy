/**
 * Pure formatting helpers for the security-activity screen.
 *
 * Extracted from `app/(tabs)/activity.tsx` so the screen keeps only data
 * wiring and layout. Everything here is platform-agnostic and React-free —
 * event-type → i18n key mapping, day-bucket grouping keys, and the localized
 * title/subtitle/relative-time formatting used by the activity rows.
 */

import type { SecurityActivity, SecurityEventType } from '@oxy.so/core';
import type { TranslateFn } from '@/lib/i18n';

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;
const MS_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR * MS_PER_MINUTE;

/**
 * Stable Intl date/time formatters keyed by locale.
 *
 * `relative` is `null` on runtimes without `Intl.RelativeTimeFormat`, in which
 * case callers fall back to the app's bucketed translation strings.
 */
export interface DayFormatters {
    longDay: Intl.DateTimeFormat;
    shortDay: Intl.DateTimeFormat;
    time: Intl.DateTimeFormat;
    relative: Intl.RelativeTimeFormat | null;
}

/**
 * Map a backend `SecurityEventType` to the localized activity label key.
 *
 * The spec includes a label the backend does not yet emit (privacyUpdate) —
 * it is wired up so that once the API starts emitting it it will render with
 * the right copy without further changes here.
 */
export function getEventLabelKey(eventType: SecurityEventType | string): string {
    switch (eventType) {
        case 'sign_in':
            return 'activity.events.signIn';
        case 'sign_out':
            return 'activity.events.signOut';
        case 'email_changed':
            return 'activity.events.emailChanged';
        case 'profile_updated':
            return 'activity.events.profileUpdate';
        case 'device_added':
            return 'activity.events.deviceAdded';
        case 'device_removed':
            return 'activity.events.deviceRemoved';
        case 'account_recovery':
            return 'activity.events.accountRecovery';
        case 'security_settings_changed':
            return 'activity.events.privacyUpdate';
        case 'private_key_exported':
            return 'activity.events.keyExported';
        case 'backup_created':
            return 'activity.events.backupCreated';
        case 'suspicious_activity':
            return 'activity.events.suspicious';
        default:
            return 'activity.events.unknown';
    }
}

/** Group label for an event timestamp — Google-style buckets. */
export type GroupKey =
    | { kind: 'today' }
    | { kind: 'yesterday' }
    | { kind: 'last7Days' }
    | { kind: 'date'; year: number; month: number; day: number };

export function getGroupKey(date: Date, now: Date): GroupKey {
    const startOfDay = (d: Date): number =>
        new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diffDays = Math.floor((startOfDay(now) - startOfDay(date)) / MS_PER_DAY);

    if (diffDays <= 0) return { kind: 'today' };
    if (diffDays === 1) return { kind: 'yesterday' };
    if (diffDays < DAYS_PER_WEEK) return { kind: 'last7Days' };
    return {
        kind: 'date',
        year: date.getFullYear(),
        month: date.getMonth(),
        day: date.getDate(),
    };
}

export function groupKeyToId(key: GroupKey): string {
    if (key.kind === 'date') return `date-${key.year}-${key.month}-${key.day}`;
    return key.kind;
}

/**
 * Format a single timestamp into a human-readable relative string.
 *
 * Prefers `Intl.RelativeTimeFormat` (with `numeric: 'auto'`, giving natural
 * phrasing like "yesterday") when the runtime supports it, and falls back to
 * the app's bucketed translation strings otherwise. Older than a week resolves
 * to an absolute short date.
 */
export function formatRelativeTime(
    dateString: string,
    formatters: DayFormatters,
    t: TranslateFn,
): string {
    const date = new Date(dateString);
    // Guard malformed input: an invalid Date makes formatters.shortDay.format
    // throw RangeError and crashes the screen. Degrade to an empty string, the
    // same way getEventTitle degrades an unknown label.
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const minutes = Math.floor(diffMs / MS_PER_MINUTE);

    if (minutes < 1) return t('activity.time.justNow');
    if (minutes < MINUTES_PER_HOUR) {
        if (formatters.relative) {
            return formatters.relative.format(-minutes, 'minute');
        }
        return t('activity.time.minutesAgo', { count: minutes });
    }
    const hours = Math.floor(minutes / MINUTES_PER_HOUR);
    if (hours < HOURS_PER_DAY) {
        if (formatters.relative) {
            return formatters.relative.format(-hours, 'hour');
        }
        return t('activity.time.hoursAgo', { count: hours });
    }
    const days = Math.floor(hours / HOURS_PER_DAY);
    if (days < DAYS_PER_WEEK) {
        if (formatters.relative) {
            return formatters.relative.format(-days, 'day');
        }
        return t('activity.time.daysAgo', { count: days });
    }
    return formatters.shortDay.format(date);
}

/** Localized title for a single event, with a server-description fallback. */
export function getEventTitle(event: SecurityActivity, t: TranslateFn): string {
    const labelKey = getEventLabelKey(event.eventType);
    const localized = t(labelKey);
    // If no translation is registered, `t` returns the raw key as a visible
    // fallback. Fall back to the server-provided description for any unknown
    // event type so the row is never empty.
    if (localized === labelKey) {
        return event.eventDescription || t('activity.events.unknown');
    }
    return localized;
}

/** Row subtitle (relative time + optional device name). */
export function getEventSubtitle(
    event: SecurityActivity,
    formatters: DayFormatters,
    t: TranslateFn,
): string {
    const relative = formatRelativeTime(event.timestamp, formatters, t);
    const deviceName =
        event.metadata && typeof event.metadata === 'object'
            ? (event.metadata as { deviceName?: unknown }).deviceName
            : undefined;
    const deviceLabel = typeof deviceName === 'string' ? deviceName : null;

    if (deviceLabel) return `${relative} • ${deviceLabel}`;
    return relative;
}
