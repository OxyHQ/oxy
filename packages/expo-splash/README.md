# @oxy.so/expo-splash

Shared **native-splash toolkit** for Oxy Expo apps. Every Oxy app gets the same
"Instagram, from Meta" splash: the app's **own logo centered** on the shared dark
brand background, with the Oxy **"from Oxy" symbol pinned to the bottom** of the
native OS splash.

The app supplies only its center logo — the Oxy bottom branding (Android +
iOS assets) is bundled with this package, so nothing is duplicated per app.

## What you get

| Piece | Entry point | Runs in | Purpose |
| --- | --- | --- | --- |
| Oxy bottom-branding config plugin | `@oxy.so/expo-splash` (in `plugins`) | prebuild (Node) | Pins the Oxy symbol to the bottom of the native splash (Android `windowSplashScreenBrandingImage` + iOS LaunchScreen storyboard). Bundles the Oxy assets. |
| `expo-splash-screen` config helper | `@oxy.so/expo-splash/config` | `app.config.js` (Node) | Builds the `["expo-splash-screen", {…}]` tuple with the Oxy-standard defaults; app passes its own logo. |
| Native-splash lifecycle helpers | `@oxy.so/expo-splash` (runtime import) | app runtime (`_layout`) | Hold the OS splash until the app is ready, then hide it — no blank gap, no duplicate custom splash on native. |

## Install

```bash
bun add @oxy.so/expo-splash
```

`expo`, `expo-splash-screen`, `react`, and `react-native` are peer dependencies
(already present in any Expo app).

## Adopt it — 3 steps

### 1. `app.config.js` — build the splash-screen config + add the branding plugin

```js
const { oxySplashScreenPlugin } = require('@oxy.so/expo-splash/config');

module.exports = {
  expo: {
    // …
    plugins: [
      'expo-router',
      // Your OWN center logo on the shared dark brand background:
      oxySplashScreenPlugin({ image: './assets/images/splash-logo.png' }),
      // Oxy "from Oxy" bottom branding. MUST come AFTER the line above —
      // it augments the splash resources that plugin generates.
      '@oxy.so/expo-splash',
    ],
  },
};
```

`oxySplashScreenPlugin` defaults (verified on-device — override only if your logo
geometry differs):

- **`imageWidth: 176`** — Android 12+ masks the splash icon to a **circle**; the
  240dp window shows only its inner ~2/3 (~160dp diameter). At width 176 a
  1024×1024 logo renders comfortably inside that safe circle. Larger widths get
  clipped by the mask.
- **`backgroundColor: '#0B0B0F'`** — the shared dark Oxy brand background. (A white
  background makes a white/light logo look like it "didn't load," and the dark bg
  matches the light Oxy bottom mark.)
- **`resizeMode: 'contain'`** — never crops the logo.
- A `dark` variant mirroring the light one, so the splash is identical in both OS
  appearance modes.

The `@oxy.so/expo-splash` branding plugin accepts an options object for
flexibility, all optional:

```js
['@oxy.so/expo-splash', {
  // imageWidth: 48,          // iOS-only bottom-mark point width (Android is
  //                          // fixed by the OS container). Default 48.
  // androidImage: './my-2.5-1-branding.png',  // override the bundled Oxy asset
  // iosImage: './my-square-branding.png',      // (rarely needed)
}]
```

> After changing native config you must re-run `expo prebuild` (or a new EAS
> build). The branding is applied at prebuild.

### 2. `app/_layout.tsx` — wire the lifecycle helpers

Make the native OS splash the **single** splash on native (hold it until the app
is ready, then hide). Gate your custom web splash to web only.

```tsx
import { Platform } from 'react-native';
import {
  preventNativeSplashAutoHide,
  useHideNativeSplashWhenReady,
} from '@oxy.so/expo-splash';
import AppSplashScreen from '@/components/AppSplashScreen';

// Hold the OS splash at module load (native only; no-op on web).
preventNativeSplashAutoHide();

export default function RootLayout() {
  const [appIsReady, setAppIsReady] = useState(false);

  // …set appIsReady(true) when fonts + init complete…

  // Hide the held OS splash the moment the app is ready (native only).
  useHideNativeSplashWhenReady(appIsReady);

  return (
    <Providers>
      {appIsReady ? (
        <App />
      ) : Platform.OS === 'web' ? (
        // WEB: your own custom splash covers font-load + init and fades out.
        <AppSplashScreen />
      ) : null /* NATIVE: the held OS splash is on top; render nothing */}
    </Providers>
  );
}
```

Prefer imperative control? Use `hideNativeSplash()` directly instead of the hook:

```tsx
import { hideNativeSplash } from '@oxy.so/expo-splash';
// …later, when ready:
hideNativeSplash();
```

### 3. Keep your `AppSplashScreen` as a **web-only** concern

Each app owns its own custom web splash visual (its own logo/animation). Gate it
to `Platform.OS === 'web'`: on native the held OS splash is the only splash, so a
custom overlay would duplicate it.

## API

Runtime (`import { … } from '@oxy.so/expo-splash'`):

- **`preventNativeSplashAutoHide(): void`** — hold the OS splash at module load
  (native only; no-op on web; swallows late-call rejections).
- **`hideNativeSplash(): void`** — hide the held OS splash (native only; no-op on
  web).
- **`useHideNativeSplashWhenReady(appIsReady: boolean): void`** — hook that hides
  the OS splash as soon as `appIsReady` flips to `true`.

Config (`const { oxySplashScreenPlugin } = require('@oxy.so/expo-splash/config')`):

- **`oxySplashScreenPlugin({ image, imageWidth?, backgroundColor?, resizeMode?, darkImage?, darkBackgroundColor? })`**
  → `['expo-splash-screen', {…}]` tuple.

Config plugin (`plugins: ['@oxy.so/expo-splash']`):

- Options: `{ imageWidth?, androidImage?, iosImage? }` — all optional; defaults
  ship the bundled Oxy symbol.

## Why the Android branding asset is 2.5:1 (800×320)

Android 12+ renders `windowSplashScreenBrandingImage` by setting the drawable as
the **background** of a branding view (`setBackground`), which **stretches to
fill** — it does *not* fit-center. The WM Shell sizes that view to the AOSP
default container `splashscreen_default_image_branding_size` = **200×80dp**
(2.5:1). So the bundled Oxy asset is authored at 2.5:1 with the symbol centered
in transparent padding, and emitted into `drawable-xxxhdpi` at 800×320px
(intrinsic = 200×80dp) so it renders sharp with no distortion. iOS uses a
separate tight square asset with `scaleAspectFit` (no stretch). See
`plugin/withOxySplashBranding.js` for the full framework-verified rationale.
