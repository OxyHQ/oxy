/**
 * Web: point dotLottie at the WebAssembly renderer SERVED BY THIS ORIGIN.
 *
 * dotLottie draws with ThorVG compiled to WebAssembly and, left alone, fetches
 * that binary from a public npm CDN (jsdelivr, then unpkg). accounts.oxy.so's
 * `connect-src` refuses both, and every page that opens an animated sticker
 * would depend on a third party being up. Bundled as an asset instead, the
 * binary ships from this origin. Compiling it needs `'wasm-unsafe-eval'` in
 * `script-src`, which the accounts CSP already allows (scripts/smoke-csp.ts).
 *
 * Through Bloom, not `@lottiefiles/dotlottie-react` directly: Bloom loads the
 * player on demand (the first animated sticker), and importing `setWasmUrl`
 * from the player here would pull all of it back into the startup bundle.
 */
import { setLottieWasmUrl } from '@oxy.so/bloom/sticker';
import { Asset } from 'expo-asset';

let configured = false;

export function configureLottieWeb(): void {
  if (configured) return;
  configured = true;
  const wasm = Asset.fromModule(require('@lottiefiles/dotlottie-web/dotlottie-player.wasm'));
  setLottieWasmUrl(wasm.uri);
}
