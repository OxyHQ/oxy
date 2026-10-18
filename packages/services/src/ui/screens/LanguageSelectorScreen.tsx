import { Button } from '@oxy.so/bloom/button';
import React, { useCallback, useMemo, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import type { BaseScreenProps } from '../types/navigation';
import { useTheme } from '@oxy.so/bloom/theme';
import Ionicons from '../icons/Ionicons';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { Search } from '@oxy.so/bloom/search';
import { CountryFlag } from '@oxy.so/bloom/phone-input';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { SUPPORTED_LANGUAGES, getNativeLanguageName, type SupportedLanguage } from '@oxy.so/core';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useOxy } from '../context/oxyRuntimeContext';
import { addLocale, removeLocale, setPrimaryLocale } from '../hooks/useLanguageManagement';
import { useUpdateProfile } from '../hooks/mutations/useAccountMutations';

interface LanguageSelectorScreenProps extends BaseScreenProps {}

// Stable leading slot keeps all locale rows aligned.
const FLAG_SLOT_SIZE = 40;
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
 * when signed out the ordered selection is stored on-device.
 */
const LanguageSelectorScreen: React.FC<LanguageSelectorScreenProps> = () => {
  const { user, isAuthenticated, currentLanguage, currentLanguages, setLanguages } = useOxy();
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
  // ordered array; guests persist the same ordered selection locally.
  const commitSelection = useCallback(
    async (next: string[], announceCode: string): Promise<void> => {
      if (isBusy || next.length === 0) {
        return;
      }
      setIsSubmitting(true);
      try {
        if (isAuthenticated && user?.id) {
          const saved = await updateProfile.mutateAsync({ languages: next });
          if (
            saved.languages?.length !== next.length ||
            next.some((locale, index) => saved.languages?.[index] !== locale)
          ) {
            toast.error(t('language.saveFailed'));
            return;
          }
        } else {
          await setLanguages(next);
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
    [isAuthenticated, user?.id, updateProfile, setLanguages, t, isBusy],
  );

  // Adding appends a locale; choosing a selected row makes it primary.
  const handleAdd = useCallback(
    (code: string) => {
      const next = addLocale(selected, code);
      void commitSelection(next, code);
    },
    [selected, commitSelection],
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

  const renderFlag = (entry: SupportedLanguage) => (
    <View style={styles.flagSlot}>
      <CountryFlag iso2={entry.region} size={28} />
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
      <GroupedSection title={t('language.selected')}>
        {selectedEntries.map((entry, index) => {
          const isPrimary = index === 0;
          const canRemove = selected.length > 1;
          return (
            <GroupedSectionItem
              key={entry.code}
              icon={renderFlag(entry)}
              title={entry.nativeName}
              description={entry.name}
              onPress={isPrimary ? undefined : () => handleSetPrimary(entry.code)}
              disabled={isBusy}
              accessibilityLabel={
                isPrimary ? `${entry.name} — ${t('language.primary')}` : entry.name
              }
              rightElement={
                isPrimary ? (
                  <View className="bg-fill-secondary rounded-full px-space-8 py-space-2">
                    <Text className="text-primary" style={styles.primaryBadge}>
                      {t('language.primary')}
                    </Text>
                  </View>
                ) : canRemove ? (
                  <Button
                    appearance="plain"
                    tone="neutral"
                    size="sm"
                    iconOnly
                    stopPropagation
                    onPress={() => handleRemove(entry.code)}
                    disabled={isBusy}
                    accessibilityLabel={`${t('language.remove')} ${entry.name}`}
                    icon={
                      <Ionicons
                        name="close-circle"
                        size={REMOVE_ICON_SIZE}
                        color={bloomTheme.colors.textSecondary}
                      />
                    }
                  />
                ) : undefined
              }
              showChevron={false}
            />
          );
        })}
      </GroupedSection>

      {/* Available locales. */}
      <GroupedSection title={t('language.available')}>
        {availableEntries.map((entry) => (
          <GroupedSectionItem
            key={entry.code}
            icon={renderFlag(entry)}
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
      </GroupedSection>
    </View>
  );
};

// StyleSheet retained ONLY for measured layout (sizes / line metrics) — no colors.
const styles = StyleSheet.create({
  flagSlot: {
    width: FLAG_SLOT_SIZE,
    height: FLAG_SLOT_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBadge: {
    fontSize: 12,
    fontWeight: '600',
  },
});

// Export memoized component to prevent unnecessary re-renders
export default React.memo(LanguageSelectorScreen);
