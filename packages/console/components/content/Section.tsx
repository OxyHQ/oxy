import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

import { RichText } from './RichText';

interface SectionProps {
  title?: string;
  /** Rich text (see `RichText`). */
  description?: string;
  children?: ReactNode;
  className?: string;
}

/** A titled block of a content screen. */
export function Section({ title, description, children, className = 'gap-3' }: SectionProps) {
  return (
    <View className={className}>
      {(title !== undefined || description !== undefined) && (
        <View className="gap-1">
          {title !== undefined && (
            <Text accessibilityRole="header" className="text-base font-semibold text-foreground">
              {title}
            </Text>
          )}
          {description !== undefined && <RichText>{description}</RichText>}
        </View>
      )}
      {children}
    </View>
  );
}
