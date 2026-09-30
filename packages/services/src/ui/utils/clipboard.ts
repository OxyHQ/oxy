/**
 * Put text on the clipboard: the browser's asynchronous Clipboard API. Rejects
 * where there is none (an insecure origin, SSR, a denied permission), so the
 * caller reports only a copy that happened.
 *
 * The native fork (`clipboard.native.ts`) uses `expo-clipboard`. React
 * Native's own `Clipboard` is deprecated and gone from newer releases, so
 * neither fork reaches for it.
 */
export async function copyText(text: string): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard?.writeText) throw new Error('clipboard unavailable');
  await clipboard.writeText(text);
}
