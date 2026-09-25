import React, { type ComponentProps } from 'react';
// The SUBPATH, never the `@expo/vector-icons` barrel: the barrel makes every
// family's `.ttf` reachable and Metro then bundles all of them.
import BaseMaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

export type MaterialCommunityIconsProps = ComponentProps<typeof BaseMaterialCommunityIcons>;

/**
 * Commons' one entry to the MaterialCommunityIcons glyph font. Import this, never
 * `@expo/vector-icons/MaterialCommunityIcons` directly (lint enforces it).
 *
 * A vector-icons glyph is a `Text` node whose content is a private-use code
 * point (`\u{F030B}`, …). A screen reader reads that node like any other text,
 * and on Android the code point is folded into the label of the pressable around
 * it, because RN builds an unlabelled accessible view's description from its
 * children's text. TalkBack then announces the raw code point.
 *
 * Every glyph in Commons is decorative: the control or row around it carries
 * the words. So the glyph is hidden from assistive technology here, once —
 * `aria-hidden` is `importantForAccessibility="no-hide-descendants"` on Android,
 * `accessibilityElementsHidden` on iOS and `aria-hidden` on web — rather than at
 * each call site, where the next icon would forget it. It is applied AFTER the
 * caller's props so it cannot be switched back on by accident; a glyph that
 * genuinely carries meaning belongs inside a view that has a label. Same rule as
 * Mention's `components/common/Ionicons.tsx`.
 */
function MaterialCommunityIcons(props: MaterialCommunityIconsProps) {
  return <BaseMaterialCommunityIcons {...props} aria-hidden />;
}

/** Kept so `keyof typeof MaterialCommunityIcons.glyphMap` still types icon names. */
MaterialCommunityIcons.glyphMap = BaseMaterialCommunityIcons.glyphMap;

export default MaterialCommunityIcons;
