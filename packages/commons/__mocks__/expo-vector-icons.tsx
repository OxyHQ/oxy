/**
 * Lightweight `@expo/vector-icons` stub for the jsdom test environment.
 *
 * Each icon renders a `<span>` carrying its glyph name (`data-icon`) and any
 * accessibility label, so component tests can assert an icon is present without
 * pulling in the real native font module. `glyphMap` is exposed (empty) because
 * `types/icons.ts` derives `MaterialCommunityIconName` from `keyof typeof
 * MaterialCommunityIcons.glyphMap`.
 *
 * App code imports one family per subpath (`@expo/vector-icons/Ionicons`) rather
 * than from the barrel, because the barrel makes every family's `.ttf`
 * reachable and Metro then bundles all 19 of them. jest maps both the barrel and
 * the subpaths here; the subpaths take the `default` export below, which is the
 * same family-agnostic stub.
 */

import React from 'react';

interface IconProps {
  name?: string;
  accessibilityLabel?: string;
}

function makeIconComponent() {
  const Icon = ({ name, accessibilityLabel }: IconProps): React.ReactElement =>
    React.createElement('span', { 'data-icon': name, 'aria-label': accessibilityLabel });
  Icon.glyphMap = {} as Record<string, number>;
  return Icon;
}

export const MaterialCommunityIcons = makeIconComponent();
export const MaterialIcons = makeIconComponent();
export const Ionicons = makeIconComponent();
export const Feather = makeIconComponent();
export const FontAwesome = makeIconComponent();

export default makeIconComponent();
