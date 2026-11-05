import React, { useCallback } from 'react';
import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { TextField, TextFieldInput, TextFieldLabel } from '@oxy.so/bloom/text-field';
import { Text } from '@oxy.so/bloom/typography';
import { useTheme } from '@oxy.so/bloom/theme';
import { PROFILE_LINK_TITLE_MAX } from '@oxy.so/contracts/client';
import Ionicons from '../icons/Ionicons';
import { clampLinkTitle, moveLinkItem, type LinkListItem } from './linkFormat';

interface LinkListEditorProps {
  items: LinkListItem[];
  onChange: (items: LinkListItem[]) => void;
  disabled?: boolean;
  /** Visible and accessible strings, resolved by the caller. */
  labels: {
    title: string;
    moveUp: string;
    moveDown: string;
    remove: string;
    /** `{{title}}` is replaced with the link's title. */
    removeNamed: (title: string) => string;
  };
}

/**
 * The profile's ordered link list. Each link has an editable title and can move
 * up or down; order is the profile's display order, and the server stores it as
 * the array's index. Reordering uses buttons rather than drag: a drag gesture
 * would not reach a screen reader, and a button does.
 */
export function LinkListEditor({ items, onChange, disabled, labels }: LinkListEditorProps) {
  const bloomTheme = useTheme();

  const setTitle = useCallback(
    (id: string, title: string) => {
      onChange(
        items.map((item) => (item.id === id ? { ...item, title: clampLinkTitle(title) } : item)),
      );
    },
    [items, onChange],
  );

  const move = useCallback(
    (index: number, delta: -1 | 1) => onChange(moveLinkItem(items, index, delta)),
    [items, onChange],
  );

  const remove = useCallback(
    (id: string) => onChange(items.filter((item) => item.id !== id)),
    [items, onChange],
  );

  return (
    <View className="gap-space-12">
      {items.map((item, index) => {
        const shownTitle = item.title || item.url;
        return (
          <View key={item.id} className="gap-space-8 pb-space-12 border-b border-border">
            <TextField disabled={disabled}>
              <TextFieldLabel>{labels.title}</TextFieldLabel>
              <TextFieldInput
                label={labels.title}
                value={item.title}
                onChangeText={(value) => setTitle(item.id, value)}
                maxLength={PROFILE_LINK_TITLE_MAX}
                autoCorrect
              />
            </TextField>
            <View className="flex-row items-center gap-space-8">
              <Text className="flex-1 text-muted-foreground" numberOfLines={1}>
                {item.url}
              </Text>
              <Button
                onPress={() => move(index, -1)}
                disabled={disabled || index === 0}
                accessibilityLabel={labels.moveUp}
                icon={
                  <Ionicons name="chevron-up" size={18} color={bloomTheme.colors.textSecondary} />
                }
                iconOnly
                tone="neutral"
                appearance="plain"
              />
              <Button
                onPress={() => move(index, 1)}
                disabled={disabled || index === items.length - 1}
                accessibilityLabel={labels.moveDown}
                icon={
                  <Ionicons name="chevron-down" size={18} color={bloomTheme.colors.textSecondary} />
                }
                iconOnly
                tone="neutral"
                appearance="plain"
              />
              <Button
                onPress={() => remove(item.id)}
                disabled={disabled}
                accessibilityLabel={labels.removeNamed(shownTitle)}
                icon={
                  <Ionicons name="trash-outline" size={18} color={bloomTheme.colors.negative} />
                }
                iconOnly
                tone="danger"
                appearance="plain"
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}
