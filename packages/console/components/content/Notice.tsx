import type { ReactNode } from 'react';
import { View } from 'react-native';

import { RichText } from './RichText';

type NoticeTone = 'neutral' | 'warning' | 'danger' | 'info';

const TONE_CLASS: Record<NoticeTone, string> = {
  neutral: 'border-border bg-muted/50',
  warning: 'border-warning bg-warning/10',
  danger: 'border-destructive bg-destructive/10',
  info: 'border-info bg-info/10',
};

const TITLE_CLASS: Record<NoticeTone, string> = {
  neutral: 'text-foreground',
  warning: 'text-warning',
  danger: 'text-destructive',
  info: 'text-info',
};

interface NoticeProps {
  tone?: NoticeTone;
  /** Rich-text title (see `RichText`). */
  title: string;
  /** Rich-text paragraphs (see `RichText`). */
  paragraphs?: ReadonlyArray<string>;
  children?: ReactNode;
  className?: string;
}

/** A bordered callout: a title and one or more rich-text paragraphs. */
export function Notice({
  tone = 'neutral',
  title,
  paragraphs = [],
  children,
  className,
}: NoticeProps) {
  return (
    <View
      accessibilityRole="alert"
      className={`gap-1.5 rounded-lg border p-4 ${TONE_CLASS[tone]} ${className ?? ''}`}
    >
      <RichText className={`text-sm font-medium ${TITLE_CLASS[tone]}`}>{title}</RichText>
      {paragraphs.map((paragraph) => (
        <RichText key={paragraph} className="text-xs leading-5 text-muted-foreground">
          {paragraph}
        </RichText>
      ))}
      {children}
    </View>
  );
}
