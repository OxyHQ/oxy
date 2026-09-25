import React from 'react';
import { Text } from '@oxy.so/bloom/typography';
import { View, StyleSheet } from 'react-native';
import { Badge } from '@oxy.so/bloom/badge';
import { GlyphButton } from '@oxy.so/bloom/button';
import { Icons } from '@/constants/icons';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';

interface ReputationHeaderProps {
  /** The big page title. */
  title: string;
  /** Pending validation requests — surfaced as a count badge on the duty button. */
  pendingCount: number;
  onOpenDuty: () => void;
}

/**
 * The page header: a big, bold, left-aligned title with a floating circular
 * icon button in the top-right (soft `card` fill, subtle shadow) that jumps to
 * the validator inbox — the persistent civic-duty shortcut. Bloom's count badge
 * overlays the button when validation requests are waiting.
 */
export function ReputationHeader({ title, pendingCount, onOpenDuty }: ReputationHeaderProps) {
  const colors = useColors();
  const { t } = useTranslation();

  return (
    <View className="flex-row items-center justify-between gap-space-12 pt-space-4">
      <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
        {title}
      </Text>

      <Badge content={pendingCount} max={9} invisible={pendingCount <= 0} placement="top-right">
        <GlyphButton
          icon={Icons.validation}
          size={44}
          glyphSize={20}
          color={colors.text}
          fill={colors.card}
          onPress={onOpenDuty}
          accessibilityLabel={t('civic.validate.dutyTitle')}
          style={[styles.iconButton, { shadowColor: colors.shadow }]}
        />
      </Badge>
    </View>
  );
}

const styles = StyleSheet.create({
  title: {
    flex: 1,
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: -1,
    lineHeight: 40,
  },
  iconButton: {
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
});
