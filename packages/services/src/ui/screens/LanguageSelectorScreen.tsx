import React, { useCallback, useMemo, useState } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import type { BaseScreenProps } from '../types/navigation';
import { useTheme } from '@oxyhq/bloom/theme';
import Ionicons from '../icons/Ionicons';
import { toast } from '@oxyhq/bloom/toast';
import { Text } from '@oxyhq/bloom/typography';
import { Search } from '@oxyhq/bloom/search';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import {
    SUPPORTED_LANGUAGES,
    getNativeLanguageName,
    type SupportedLanguage,
} from '@oxyhq/core';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useOxy } from '../context/OxyContext';
import { addLocale, removeLocale, setPrimaryLocale } from '../hooks/useLanguageManagement';
import { useUpdateProfile } from '../hooks/mutations/useAccountMutations';

interface LanguageSelectorScreenProps extends BaseScreenProps { }

// Size (in dp) of the circular chip rendered as each row's leading icon.
const CHIP_SIZE = 40;
// Trailing remove-affordance icon size (dp).
const REMOVE_ICON_SIZE = 24;

/** O(1) catalog lookup by canonical locale code. */
const CATALOG_BY_CODE: ReadonlyMap<string, SupportedLanguage> = new Map(
    SUPPORTED_LANGUAGES.map((entry) => [entry.code, entry]),
);

/**
 * LanguageSelectorScreen — multi-select over the supported BCP-47 locales.
 *
 * The user picks one or more locales; the FIRST (primary) drives the app's UI
 * language. When signed in the ordered selection is persisted to the account
 * (`updateProfile({ languages })`, primary first) and every Oxy app follows it;
 * when signed out a single local override is stored on-device.
 */
const LanguageSelectorScreen: React.FC<LanguageSelectorScreenProps> = () => {
    const { user, isAuthenticated, currentLanguage, currentLanguages, setLanguage } = useOxy();
    const { t } = useI18n();
    const bloomTheme = useTheme();
    const updateProfile = useUpdateProfile();
    const [query, setQuery] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    // The Dialog owns the nav header + large collapsing title; this screen just
    // declares its title/subtitle.
    useSurfaceHeader({ title: t('language.title'), subtitle: t('language.subtitle') || undefined });

    // The current ordered selection: the account locales when signed in, else
    // the single guest/device locale. Always non-empty (`currentLanguage`
    // resolves to the device or fallback locale).
    const selected = useMemo<string[]>(
        () => (currentLanguages.length > 0 ? currentLanguages : [currentLanguage]),
        [currentLanguages, currentLanguage],
    );

    const selectedSet = useMemo(() => new Set(selected), [selected]);

    const selectedEntries = useMemo<SupportedLanguage[]>(
        () =>
            selected
                .map((code) => CATALOG_BY_CODE.get(code))
                .filter((entry): entry is SupportedLanguage => entry !== undefined),
        [selected],
    );

    // Available = supported locales not already selected, filtered by the query
    // (matches English name + native name).
    const availableEntries = useMemo<SupportedLanguage[]>(() => {
        const normalizedQuery = query.trim().toLowerCase();
        return SUPPORTED_LANGUAGES.filter((entry) => {
            if (selectedSet.has(entry.code)) {
                return false;
            }
            if (!normalizedQuery) {
                return true;
            }
            return (
                entry.name.toLowerCase().includes(normalizedQuery) ||
                entry.nativeName.toLowerCase().includes(normalizedQuery)
            );
        });
    }, [query, selectedSet]);

    const isBusy = isSubmitting || updateProfile.isPending;

    // Persist the next ordered selection. Signed-in accounts write the full
    // ordered array; guests store only the primary locally.
    const commitSelection = useCallback(
        async (next: string[], announceCode: string): Promise<void> => {
            if (isBusy || next.length === 0) {
                return;
            }
            setIsSubmitting(true);
            try {
                if (isAuthenticated && user?.id) {
                    await updateProfile.mutateAsync({ languages: next });
                } else {
                    await setLanguage(next[0]);
                }
                toast.success(t('language.changed', { lang: getNativeLanguageName(announceCode) }));
            } catch (error) {
                // `useUpdateProfile` already surfaces a toast on failure; only the
                // local (guest) path needs its own error toast.
                if (!(isAuthenticated && user?.id)) {
                    toast.error(t('language.saveFailed'));
                }
                if (__DEV__) {
                    console.error('Error saving language preference:', error);
                }
            } finally {
                setIsSubmitting(false);
            }
        },
        [isAuthenticated, user?.id, updateProfile, setLanguage, t, isBusy],
    );

    // Adding a locale: signed-in appends (non-primary); a guest can only hold a
    // single locale, so the tapped locale becomes their primary.
    const handleAdd = useCallback(
        (code: string) => {
            const next = isAuthenticated && user?.id ? addLocale(selected, code) : [code];
            void commitSelection(next, code);
        },
        [isAuthenticated, user?.id, selected, commitSelection],
    );

    const handleSetPrimary = useCallback(
        (code: string) => {
            if (selected[0] === code) {
                return;
            }
            void commitSelection(setPrimaryLocale(selected, code), code);
        },
        [selected, commitSelection],
    );

    const handleRemove = useCallback(
        (code: string) => {
            if (selected.length <= 1) {
                return;
            }
            const next = removeLocale(selected, code);
            const announceCode = next[0] ?? code;
            void commitSelection(next, announceCode);
        },
        [selected, commitSelection],
    );

    const renderChip = (entry: SupportedLanguage) => (
        <View className="bg-fill-secondary items-center justify-center" style={styles.chip}>
            <Text className="text-text-secondary" style={styles.chipLabel}>
                {entry.language.toUpperCase()}
            </Text>
        </View>
    );

    return (
        <View className="pt-space-24 pb-space-24 px-screen-margin">
            <View className="mb-space-16">
                <Search
                        value={query}
                        onChangeText={setQuery}
                        onClearText={() => setQuery('')}
                        label={t('language.search') || 'Search languages'}
                    />
                </View>

                {/* Selected locales — ordered, primary first. */}
                <SettingsListGroup title={t('language.selected')}>
                    {selectedEntries.map((entry, index) => {
                        const isPrimary = index === 0;
                        const canRemove = selected.length > 1;
                        return (
                            <SettingsListItem
                                key={entry.code}
                                icon={renderChip(entry)}
                                title={entry.nativeName}
                                description={entry.name}
                                onPress={isPrimary ? undefined : () => handleSetPrimary(entry.code)}
                                disabled={isBusy}
                                accessibilityLabel={
                                    isPrimary
                                        ? `${entry.name} — ${t('language.primary')}`
                                        : entry.name
                                }
                                rightElement={
                                    isPrimary ? (
                                        <View className="bg-fill-secondary rounded-full px-space-8 py-space-2">
                                            <Text className="text-primary" style={styles.primaryBadge}>
                                                {t('language.primary')}
                                            </Text>
                                        </View>
                                    ) : canRemove ? (
                                        <TouchableOpacity
                                            onPress={() => handleRemove(entry.code)}
                                            disabled={isBusy}
                                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                            accessibilityRole="button"
                                            accessibilityLabel={`${t('language.remove')} ${entry.name}`}
                                        >
                                            <Ionicons
                                                name="close-circle"
                                                size={REMOVE_ICON_SIZE}
                                                color={bloomTheme.colors.textSecondary}
                                            />
                                        </TouchableOpacity>
                                    ) : undefined
                                }
                                showChevron={false}
                            />
                        );
                    })}
                </SettingsListGroup>

                {/* Available locales. */}
                <SettingsListGroup title={t('language.available')}>
                    {availableEntries.map((entry) => (
                        <SettingsListItem
                            key={entry.code}
                            icon={renderChip(entry)}
                            title={entry.nativeName}
                            description={entry.name}
                            onPress={() => handleAdd(entry.code)}
                            disabled={isBusy}
                            accessibilityLabel={entry.name}
                            rightElement={
                                <Ionicons
                                    name="add-circle-outline"
                                    size={REMOVE_ICON_SIZE}
                                    color={bloomTheme.colors.textSecondary}
                                />
                            }
                            showChevron={false}
                        />
                    ))}
                </SettingsListGroup>
        </View>
    );
};

// StyleSheet retained ONLY for measured layout (sizes / line metrics) — no colors.
const styles = StyleSheet.create({
    chip: {
        width: CHIP_SIZE,
        height: CHIP_SIZE,
        borderRadius: CHIP_SIZE / 2,
    },
    chipLabel: {
        fontSize: 13,
        fontWeight: '600',
    },
    primaryBadge: {
        fontSize: 12,
        fontWeight: '600',
    },
});

// Export memoized component to prevent unnecessary re-renders
export default React.memo(LanguageSelectorScreen);
