import React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import {
  AdmonitionContent,
  AdmonitionIcon,
  AdmonitionRoot,
  AdmonitionRow,
  AdmonitionText,
} from '@oxy.so/bloom/admonition';

interface ImportantBannerProps {
  children: React.ReactNode;
  title?: string;
  style?: StyleProp<ViewStyle>;
  /** `warning` (the default) or `error`, for something already irreversible. */
  type?: 'warning' | 'error';
}

/**
 * A titled warning banner, composed from Bloom's `Admonition` PARTS.
 *
 * A component rather than `<Admonition>` at each call site because of the
 * TITLE: Bloom's one-shot `Admonition` takes only children, and the parts exist
 * for exactly this. `AdmonitionIcon` draws the glyph the banner's `type` implies.
 */
export function ImportantBanner({
  children,
  title,
  style,
  type = 'warning',
}: ImportantBannerProps) {
  return (
    <AdmonitionRoot type={type} style={style}>
      <AdmonitionRow>
        <AdmonitionIcon />
        <AdmonitionContent>
          {title ? <AdmonitionText style={{ fontWeight: '600' }}>{title}</AdmonitionText> : null}
          <AdmonitionText>{children}</AdmonitionText>
        </AdmonitionContent>
      </AdmonitionRow>
    </AdmonitionRoot>
  );
}
