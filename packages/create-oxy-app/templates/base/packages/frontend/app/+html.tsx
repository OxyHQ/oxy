import { ScrollViewStyleReset, useServerDocumentContext } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

// Web document shell for static rendering. On Expo SDK 58 a custom +html must
// render the server document context's `headNodes` and `bodyNodes`: they carry
// the app's script and stylesheet tags, and a static export without them ships
// a page with no JS or CSS.
export default function Root({ children }: PropsWithChildren) {
  const { htmlAttributes, bodyAttributes, headNodes, bodyNodes } = useServerDocumentContext();
  return (
    <html lang="en" {...htmlAttributes}>
      <head>
        <meta charSet="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        {/* Startup fallback; Bloom adopts one entry and becomes the runtime owner. */}
        <meta name="theme-color" content="#faf1f6" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#100d10" media="(prefers-color-scheme: dark)" />
        <ScrollViewStyleReset />
        {headNodes}
      </head>
      <body {...bodyAttributes}>
        {children}
        {bodyNodes}
      </body>
    </html>
  );
}
