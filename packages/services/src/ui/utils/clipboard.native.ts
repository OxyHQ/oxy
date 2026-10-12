/**
 * Put text on the clipboard on iOS and Android, through `expo-clipboard`.
 * React Native's own `Clipboard` is deprecated and gone from newer releases.
 *
 * `expo-clipboard` is an OPTIONAL peer, so an app without it (or with the JS but
 * not the native module, before a rebuild) must still bundle and boot: the copy
 * rejects here and the caller says nothing was copied.
 *
 * Metro resolves a dynamic `import()` at BUILD time, like a static import, so
 * being dynamic is not what makes it optional. Metro marks a dependency optional
 * (writing `null` into the dependency map instead of failing the bundle) only
 * when the `import()`/`require()` of a string literal sits in a statement whose
 * NEAREST enclosing block is a `try` block, or ends in a promise chain with a
 * rejection handler (`isOptionalDependency` in metro's `collectDependencies`).
 * This file used to `await import('expo-clipboard')` outside any `try`, and
 * every Android or iOS bundle of an app without `expo-clipboard` failed with
 * `Unable to resolve module expo-clipboard`, though nothing in that app ever
 * copied anything. Keep the `import()` a direct statement of the `try` below:
 * one `if` block of nesting inside the `try` loses the optionality again.
 * `optionalPeerLoads.test.ts` holds every optional peer to that shape.
 *
 * Only this NATIVE fork names the package; the default fork (`clipboard.ts`,
 * which `tsc`, Vite and SSR resolve) names nothing, so a consumer's type graph
 * reaches `expo-clipboard` only when it typechecks `.native` files
 * (`moduleSuffixes`) — the case package-rules.md#package-boundaries warns
 * about. `clipboardIsolation.test.ts` keeps it that way.
 */
export async function copyText(text: string): Promise<void> {
  let clipboard: typeof import('expo-clipboard');
  try {
    clipboard = await import('expo-clipboard');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`clipboard unavailable: expo-clipboard could not be loaded (${reason})`);
  }
  await clipboard.setStringAsync(text);
}
