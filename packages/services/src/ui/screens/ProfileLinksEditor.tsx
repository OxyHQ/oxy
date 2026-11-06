import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Chip } from '@oxy.so/bloom/chip';
import { SortableChipRow } from '@oxy.so/bloom/sortable-chip-row';
import { surfaces } from '@oxy.so/bloom/surfaces';
import { PROFILE_LINKS_MAX } from '@oxy.so/contracts/client';
import { useI18n } from '../hooks/useI18n';
import { ProfileLinkForm } from './ProfileLinkForm';
import {
  applyLinkFormResult,
  getLinkTitle,
  type LinkFormResult,
  type LinkListItem,
} from './linkFormat';

interface ProfileLinksEditorProps {
  items: LinkListItem[];
  onChange: (items: LinkListItem[]) => void;
  disabled?: boolean;
}

let linkCounter = 0;
/** A fresh id for a link added in this editing session. */
const newLinkId = (): string => {
  linkCounter += 1;
  return `link-new-${Date.now().toString(36)}-${linkCounter}`;
};

/** The text a link's pill shows: its title, else its address without the scheme. */
const pillLabel = (item: LinkListItem): string => item.title || getLinkTitle(item.url);

/**
 * The profile's links as pills, in the order they are shown, reordered by
 * dragging. Tapping a pill edits that link; "Add link" appears until the profile
 * holds the maximum. Changes stay local until the profile is saved.
 */
export function ProfileLinksEditor({ items, onChange, disabled = false }: ProfileLinksEditorProps) {
  const { t } = useI18n();

  const openForm = async (index: number | null) => {
    const link = index === null ? undefined : items[index];
    const result = await surfaces.present<LinkFormResult | undefined>((surface) => (
      <ProfileLinkForm
        surface={surface}
        link={link}
        existingUrls={items.filter((_, i) => i !== index).map((item) => item.url)}
      />
    ));
    if (!result) return;
    onChange(applyLinkFormResult(items, index, result, PROFILE_LINKS_MAX, newLinkId));
  };

  const rowItems = items.map((item, index) => ({
    key: item.id,
    label: pillLabel(item),
    node: (
      <Chip
        size="md"
        variant="subtle"
        accessibilityLabel={t('editProfile.items.links.editLink', {
          defaultValue: 'Edit {{label}}',
          label: pillLabel(item),
        })}
        onPress={() => void openForm(index)}
        disabled={disabled}
      >
        {pillLabel(item)}
      </Chip>
    ),
  }));

  return (
    <SortableChipRow
      items={rowItems}
      disabled={disabled}
      onReorder={(keys) => {
        const byKey = new Map(items.map((item) => [item.id, item]));
        onChange(keys.flatMap((key) => (byKey.has(key) ? [byKey.get(key) as LinkListItem] : [])));
      }}
      accessibilityLabel={t('editProfile.items.links.title') || 'Links'}
      trailing={
        items.length < PROFILE_LINKS_MAX ? (
          <View>
            <Button
              appearance="outline"
              tone="neutral"
              size="sm"
              disabled={disabled}
              onPress={() => void openForm(null)}
            >
              {t('editProfile.items.links.form.add') || 'Add link'}
            </Button>
          </View>
        ) : null
      }
    />
  );
}
