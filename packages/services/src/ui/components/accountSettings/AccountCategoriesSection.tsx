import type React from 'react';
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { Button, CloseButton } from '@oxy.so/bloom/button';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { useTheme } from '@oxy.so/bloom/theme';
import {
  ACCOUNT_CATEGORY_IDS,
  MAX_ACCOUNT_CATEGORIES,
  SELECTABLE_ACCOUNT_CATEGORY_IDS,
  accountCategoryLabel,
  type AccountCategoryId,
} from '@oxy.so/core';
import MaterialCommunityIcons from '../../icons/MaterialCommunityIcons';
import { SettingsIcon } from '../SettingsIcon';
import { useI18n } from '../../hooks/useI18n';

/**
 * An account's categories are an ORDERED list whose element 0 is the primary —
 * nothing else records which one is. So nothing here sorts: a choice joins at
 * the end (choosing a second category must not demote the first), "Make
 * primary" moves one to the front, and two lists are equal only in the same
 * order (a promotion changes nothing BUT the order).
 */
export function toggleAccountCategory(
  current: readonly AccountCategoryId[],
  id: AccountCategoryId,
): AccountCategoryId[] {
  if (current.includes(id)) return current.filter((entry) => entry !== id);
  if (current.length >= MAX_ACCOUNT_CATEGORIES) return [...current];
  return [...current, id];
}

export function promoteAccountCategory(
  current: readonly AccountCategoryId[],
  id: AccountCategoryId,
): AccountCategoryId[] {
  if (!current.includes(id)) return [...current];
  return [id, ...current.filter((entry) => entry !== id)];
}

export function accountCategoriesEqual(
  a: readonly AccountCategoryId[],
  b: readonly AccountCategoryId[],
): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/**
 * A stored id can be one this build has never heard of — the vocabulary grows
 * at Oxy, and an older client meets the newer id. It keeps its row (it counts
 * against the cap and survives a save) but is never printed raw.
 */
const KNOWN_IDS: ReadonlySet<string> = new Set(ACCOUNT_CATEGORY_IDS);

interface AccountCategoriesSectionProps {
  value: readonly AccountCategoryId[];
  onChange: (next: AccountCategoryId[]) => void;
  disabled?: boolean;
}

/**
 * The categories editor of `AccountSettings`: the chosen categories in their
 * stored order (primary first), and a collapsible list of the vocabulary to add
 * from. Only SELECTABLE ids are offered — a withdrawn one stays on an account
 * that carries it, but Oxy refuses newly adding it.
 */
export const AccountCategoriesSection: React.FC<AccountCategoriesSectionProps> = ({
  value,
  onChange,
  disabled = false,
}) => {
  const { colors } = useTheme();
  const { t, locale } = useI18n();
  const [pickerOpen, setPickerOpen] = useState(false);
  const atCap = value.length >= MAX_ACCOUNT_CATEGORIES;

  const labelOf = useCallback(
    (id: AccountCategoryId) =>
      KNOWN_IDS.has(id)
        ? accountCategoryLabel(locale, id)
        : t('accounts.settings.categories.unavailable'),
    [locale, t],
  );
  const toggle = useCallback(
    (id: AccountCategoryId) => onChange(toggleAccountCategory(value, id)),
    [onChange, value],
  );

  return (
    <View className="gap-space-8">
      <GroupedSection
        title={t('accounts.settings.categories.title')}
        footer={t('accounts.settings.categories.footer', { max: MAX_ACCOUNT_CATEGORIES })}
      >
        {value.map((id, index) => {
          const label = labelOf(id);
          return (
            <GroupedSectionItem
              key={id}
              icon={
                <SettingsIcon
                  name={index === 0 ? 'star' : 'tag-outline'}
                  color={index === 0 ? colors.primary : colors.textSecondary}
                />
              }
              title={label}
              description={index === 0 ? t('accounts.settings.categories.primary') : undefined}
              showChevron={false}
              disabled={disabled}
              rightElement={
                <View className="flex-row items-center gap-space-8">
                  {index > 0 ? (
                    <Button
                      appearance="subtle"
                      size="xs"
                      disabled={disabled}
                      onPress={() => onChange(promoteAccountCategory(value, id))}
                    >
                      {t('accounts.settings.categories.makePrimary')}
                    </Button>
                  ) : null}
                  <CloseButton
                    size="xs"
                    disabled={disabled}
                    onPress={() => toggle(id)}
                    accessibilityLabel={t('accounts.settings.categories.remove', {
                      category: label,
                    })}
                  />
                </View>
              }
            />
          );
        })}
        <GroupedSectionItem
          icon={<SettingsIcon name="plus" color={colors.textSecondary} />}
          title={t('accounts.settings.categories.add')}
          description={
            atCap
              ? t('accounts.settings.categories.atCap', { max: MAX_ACCOUNT_CATEGORIES })
              : undefined
          }
          disabled={disabled || atCap}
          showChevron={false}
          rightElement={
            <MaterialCommunityIcons
              name={pickerOpen ? 'chevron-up' : 'chevron-down'}
              size={20}
              color={colors.textSecondary}
            />
          }
          onPress={() => setPickerOpen((open) => !open)}
        />
      </GroupedSection>

      {pickerOpen && !atCap ? (
        <GroupedSection>
          {SELECTABLE_ACCOUNT_CATEGORY_IDS.map((id) => {
            const selected = value.includes(id);
            return (
              <GroupedSectionItem
                key={id}
                title={accountCategoryLabel(locale, id)}
                showChevron={false}
                disabled={disabled}
                rightElement={
                  selected ? (
                    <MaterialCommunityIcons name="check-circle" size={20} color={colors.primary} />
                  ) : undefined
                }
                onPress={() => toggle(id)}
              />
            );
          })}
        </GroupedSection>
      ) : null}
    </View>
  );
};
