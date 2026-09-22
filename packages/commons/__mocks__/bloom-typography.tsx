import React from 'react';

/**
 * Lightweight `@oxy.so/bloom/typography` stub — `useTheme()` through a relative
 * import, as with every other Bloom family this suite stubs.
 *
 * Each primitive renders a DOM node that keeps its children, so every assertion
 * these suites make about COPY keeps working. Headings render as real `<h1>`…
 * `<h6>` so a query by heading role still finds them.
 */
const text = (tag: string) =>
  function TextPart({
    children,
    testID,
    accessibilityLabel,
    accessibilityRole,
  }: {
    children?: React.ReactNode;
    testID?: string;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    [key: string]: unknown;
  }) {
    // `testID` and `accessibilityLabel` are forwarded because they are what the
    // suites query on: a bare passthrough dropped them and nine assertions went
    // looking for elements that no longer carried their handle.
    return React.createElement(
      tag,
      {
        'data-testid': testID,
        'aria-label': accessibilityLabel,
        role: accessibilityRole,
      },
      children,
    );
  };

export const Text = text('span');
export const Span = text('span');
export const P = text('p');
export const Lead = text('p');
export const Large = text('span');
export const Small = text('span');
export const Muted = text('span');
export const Blockquote = text('blockquote');
export const H1 = text('h1');
export const H2 = text('h2');
export const H3 = text('h3');
export const H4 = text('h4');
export const H5 = text('h5');
export const H6 = text('h6');
