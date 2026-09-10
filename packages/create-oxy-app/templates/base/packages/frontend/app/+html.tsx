import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
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
      </head>
      <body>{children}</body>
    </html>
  );
}
