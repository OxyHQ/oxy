import React from 'react';
import { StyleSheet, View } from 'react-native';
import { H3, Text } from '@oxy.so/bloom/typography';
import { useColors } from '@/hooks/useColors';

interface SectionHeaderProps {
  title: string;
  subtitle?: string;
}

/**
 * The flat section title block: Bloom's `H3` with an optional muted subtitle.
 * No card, no rule — sections are separated by the screen's whitespace rhythm,
 * not boxes. For a quieter step, `H4` is the one-line change here.
 */
function SectionHeader({ title, subtitle }: SectionHeaderProps) {
  const colors = useColors();
  return (
    <View className="gap-space-4">
      <H3>{title}</H3>
      {subtitle && <Text style={{ color: colors.textSecondary }}>{subtitle}</Text>}
    </View>
  );
}

interface SectionProps {
  title?: string;
  subtitle?: string;
  children?: React.ReactNode;
}

/**
 * A titled content group. The header (if any) sits a tight 12pt above its body;
 * the outer screen gap (32pt) is what separates one `Section` from the next, so
 * the page breathes without nesting boxes.
 */
export function Section({ title, subtitle, children }: SectionProps) {
  return (
    <View style={styles.section}>
      {title && <SectionHeader title={title} subtitle={subtitle} />}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 12 },
});
