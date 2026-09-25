import { createElement, type ComponentProps, type ComponentType } from 'react';

/** Function built-ins and statics a function component must not inherit. */
const NOT_COPIED = new Set(['length', 'name', 'prototype', 'caller', 'arguments', 'defaultProps', 'displayName']);

/**
 * Wrap an icon-font family so every glyph it renders is hidden from assistive
 * technology.
 *
 * A vector-icons glyph is a `Text` node whose content is a private-use code
 * point. A screen reader reads it like any other text: Android QA of the account
 * menu found `"\u{F0140}"` announced next to "Switch account" (OxyHQ/oxy#1375),
 * and on Android the code point is folded into the label of the pressable around
 * it, because RN builds an unlabelled accessible view's description from its
 * children's text.
 *
 * Every glyph in this SDK is decorative — the control or row around it carries
 * the words — so it is hidden here, once, rather than at each call site where
 * the next icon would forget it. `aria-hidden` is
 * `importantForAccessibility="no-hide-descendants"` on Android,
 * `accessibilityElementsHidden` on iOS and `aria-hidden` on web. It is applied
 * AFTER the caller's props so it cannot be switched back on; a glyph that needs
 * a name belongs inside a control that has one. (Mention's own wrapper,
 * `components/common/Ionicons.tsx`, is the same rule.)
 *
 * The family's statics (`glyphMap`, `getImageSource`, `loadFont`, …) are carried
 * over, so the wrapper is a drop-in for the family itself.
 */
// biome-ignore lint/suspicious/noExplicitAny: an icon family's own props are whatever `createIconSet` typed them as; the wrapper returns the SAME type.
export function decorativeIconSet<T extends ComponentType<any>>(IconSet: T, displayName: string): T {
  function DecorativeIcon(props: ComponentProps<T>) {
    return createElement(IconSet, { ...props, 'aria-hidden': true });
  }
  for (const key of Object.getOwnPropertyNames(IconSet)) {
    if (NOT_COPIED.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(IconSet, key);
    if (descriptor) Object.defineProperty(DecorativeIcon, key, descriptor);
  }
  DecorativeIcon.displayName = displayName;
  return DecorativeIcon as unknown as T;
}
