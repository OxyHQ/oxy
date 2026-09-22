import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Item } from '@oxy.so/bloom/item';
import { AppIcon, Icons, type IconName } from '@/constants/icons';
import { useColors } from '@/hooks/useColors';
import { useHaptics } from '@oxy.so/bloom/hooks';
import { Text } from '@oxy.so/bloom/typography';

interface ListRowProps {
  /** A BARE leading glyph — no circle, no chip. Defaults to the muted tertiary tint. */
  icon?: IconName;
  iconColor?: string;
  title: string;
  subtitle?: string;
  /** Right-aligned readout (e.g. a count, a status word). */
  value?: string;
  valueColor?: string;
  /** A trailing element that replaces the value/chevron region (pill, switch…). */
  trailing?: React.ReactNode;
  onPress?: () => void;
  showChevron?: boolean;
  disabled?: boolean;
  /** Render the title (and default icon) in the error tint. */
  destructive?: boolean;
}

/**
 * One comfortable list row — now Bloom's `Item` with this app's slots filled in.
 *
 * `Item` is "the one row primitive": it owns the height, the press feedback, the
 * disabled treatment, the title/subtitle column and the announced role, so a row
 * here is the same row as one in every other Oxy app. What this wrapper keeps is
 * the three things that are Commons' own and would otherwise be repeated at
 * every call site: the leading glyph comes from the app's icon vocabulary rather
 * than being passed as a node, the right-hand READOUT (a count, a status word)
 * and the chevron share one trailing slot, and both default their colour from
 * `useColors()`.
 *
 * VISUAL DELTA from the hand-rolled version: the row's geometry is Bloom's
 * (`comfortable` density) rather than the previous 16pt vertical padding on a
 * 56pt floor, the title and subtitle take Bloom's type roles instead of 16/500
 * and 13/18, and the press feedback is Bloom's rather than
 * `TouchableOpacity activeOpacity={0.6}`.
 */
export function ListRow({
  icon,
  iconColor,
  title,
  subtitle,
  value,
  valueColor,
  trailing,
  onPress,
  showChevron,
  disabled = false,
  destructive = false,
}: ListRowProps) {
  const colors = useColors();
  const haptics = useHaptics();

  const glyphColor = iconColor ?? (destructive ? colors.error : colors.textTertiary);

  // One trailing slot has to carry up to three things — a caller's element, the
  // readout, and the chevron — so they are composed here rather than fighting
  // over `Item`'s single slot.
  const tail =
    trailing || value != null || showChevron ? (
      <View className="flex-row items-center gap-space-8">
        {trailing}
        {value != null && (
          <Text style={[styles.value, { color: valueColor ?? colors.text }]} numberOfLines={1}>
            {value}
          </Text>
        )}
        {showChevron && <Icons.forward size="md" fill={colors.textTertiary} />}
      </View>
    ) : undefined;

  return (
    <Item
      leading={icon ? <AppIcon name={icon} size="md" fill={glyphColor} /> : undefined}
      title={title}
      subtitle={subtitle}
      trailing={tail}
      onPress={onPress ? () => { haptics('light'); onPress(); } : undefined}
      disabled={disabled}
      destructive={destructive}
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
    />
  );
}

const styles = StyleSheet.create({
  value: {
    fontVariant: ['tabular-nums'],
  },
});
