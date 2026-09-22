import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { H3, Text } from '@oxy.so/bloom/typography';
import { useColors } from '@/hooks/useColors';

interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  /** Optional right-aligned element (e.g. a count pill or a quiet link). */
  trailing?: React.ReactNode;
}

/**
 * The flat section title block: a heading with an optional muted subtitle
 * beneath it. No card, no rule — sections are separated by the screen's
 * whitespace rhythm, not boxes.
 *
 * The two texts are Bloom's `H3` and `Text` rather than the hand-set 17/700 and
 * 13/18 they used to be, so a section title is the same heading as every other
 * heading in the ecosystem and announces as one on web.
 *
 * VISUAL DELTA: `H3` is 24/32 at weight 600 against the previous 17/700, so
 * section titles are noticeably larger. That is Bloom's ramp; if the flat screens
 * want the quieter step, `H4` (20/28) or a `subtitle`-role `Text` is the change,
 * and it is one line here rather than twenty-three call sites.
 */
export function SectionHeader({ title, subtitle, trailing }: SectionHeaderProps) {
  const colors = useColors();
  return (
    <View className="gap-space-4">
      <View className="flex-row items-center justify-between gap-space-12">
        <H3>{title}</H3>
        {trailing}
      </View>
      {subtitle && <Text style={{ color: colors.textSecondary }}>{subtitle}</Text>}
    </View>
  );
}

interface SectionProps {
  title?: string;
  subtitle?: string;
  trailing?: React.ReactNode;
  children?: React.ReactNode;
  /** Air between the header and the section body. */
  gap?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * A titled content group. The header (if any) sits a tight 12pt above its body;
 * the outer screen gap (32pt) is what separates one `Section` from the next, so
 * the page breathes without nesting boxes.
 */
export function Section({ title, subtitle, trailing, children, gap = 12, style }: SectionProps) {
  return (
    <View style={[{ gap }, style]}>
      {title && <SectionHeader title={title} subtitle={subtitle} trailing={trailing} />}
      {children}
    </View>
  );
}

