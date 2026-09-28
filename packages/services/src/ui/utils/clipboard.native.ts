/**
 * Put text on the clipboard on iOS and Android, through `expo-clipboard`.
 * React Native's own `Clipboard` is deprecated and gone from newer releases.
 *
 * `expo-clipboard` is an OPTIONAL peer, loaded with `import()` so an app
 * without it (or with the JS but not the native module, before a rebuild)
 * still bundles and boots: the copy rejects here and the caller says nothing
 * was copied. A static import would instead fail the Metro build or throw
 * while the root barrel evaluates.
 *
 * Only this NATIVE fork names the package; the default fork (`clipboard.ts`,
 * which `tsc`, Vite and SSR resolve) names nothing, so a consumer's type graph
 * reaches `expo-clipboard` only when it typechecks `.native` files
 * (`moduleSuffixes`) — the case package-rules.md#package-boundaries warns
 * about. `clipboardIsolation.test.ts` keeps it that way.
 */
export async function copyText(text: string): Promise<void> {
  const clipboard = await import('expo-clipboard');
  await clipboard.setStringAsync(text);
}
