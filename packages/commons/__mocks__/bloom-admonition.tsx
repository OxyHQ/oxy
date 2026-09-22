import React from 'react';

/**
 * Lightweight `@oxy.so/bloom/admonition` stub — `useTheme()` through a relative
 * import again, same as the button, badge, empty-state and loading stubs.
 *
 * Every part renders a plain element that keeps its children, so the copy a
 * callout carries stays queryable by text. `AdmonitionIcon` renders nothing:
 * it draws a glyph and no test asks about one.
 */
const passthrough = (tag: string) =>
  function Part({ children }: { children?: React.ReactNode; [key: string]: unknown }) {
    return React.createElement(tag, null, children);
  };

export const AdmonitionRoot = passthrough('div');
export const AdmonitionRow = passthrough('div');
export const AdmonitionContent = passthrough('div');
export const AdmonitionText = passthrough('span');
export const Admonition = passthrough('div');
export const AdmonitionButton = passthrough('button');

export function AdmonitionIcon(): null {
  return null;
}
