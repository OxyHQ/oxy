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
 * It used to draw itself: a `bannerWarning*` colour triple from the app's own
 * `DomainColors`, a 1px border, a 16 radius, a 24 glyph and two hand-set type
 * sizes. All of that is what `AdmonitionRoot` / `AdmonitionRow` /
 * `AdmonitionIcon` already paint, from Bloom's theme, and the three
 * `bannerWarning*` tokens are retired with it.
 *
 * It survives as a component rather than becoming `<Admonition>` at each call
 * site because of the TITLE: five of its seven callers pass one ("This cannot
 * be undone", "Write this down"), and Bloom's one-shot `Admonition` takes only
 * children. The parts exist for exactly this, and composing them here once
 * beats composing them seven times.
 *
 * The `icon` and `iconSize` props are gone. `AdmonitionIcon` draws the glyph its
 * TYPE implies, which is the whole point of a typed callout — every caller was
 * passing an alert glyph to a warning banner anyway.
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
