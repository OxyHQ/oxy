// Dynamic Expo config. A development build can sit next to the production app on
// the same device via APP_VARIANT=development (distinct id + name).
const { oxySplashScreenPlugin } = require('@oxy.so/expo-splash/config');

const IS_DEV = process.env.APP_VARIANT === 'development';

const APP_ID = IS_DEV ? '{{BUNDLE_ID}}.dev' : '{{BUNDLE_ID}}';
const APP_NAME = IS_DEV ? '{{APP_NAME}} (Dev)' : '{{APP_NAME}}';

module.exports = {
  expo: {
    name: APP_NAME,
    slug: '{{APP_SLUG}}',
    scheme: '{{APP_SCHEME}}',
    version: '0.1.0',
    orientation: 'portrait',
    // The assets/images/*.png icons and splash logo are PLACEHOLDERS: replace the
    // SVGs next to them with your app's mark and run scripts/render-app-icons.mjs.
    // A native build needs all of them — `expo-splash-screen` without an image
    // fails `:app:processReleaseResources` on `drawable/splashscreen_logo`.
    icon: './assets/images/icon.png',
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: APP_ID,
      icon: './assets/images/icon.png',
    },
    android: {
      package: APP_ID,
      adaptiveIcon: {
        foregroundImage: './assets/images/icon_foreground.png',
        backgroundImage: './assets/images/icon_background.png',
        monochromeImage: './assets/images/icon_monochrome.png',
      },
    },
    web: {
      bundler: 'metro',
      output: 'single',
      favicon: './assets/images/favicon.png',
    },
    plugins: [
      'expo-router',
      // Oxy-standard native splash: the app's own mark centered on the shared dark
      // brand background, with the "from Oxy" bottom branding added by the
      // '@oxy.so/expo-splash' plugin, which MUST stay immediately after it.
      oxySplashScreenPlugin({ image: './assets/images/splash-logo.png' }),
      '@oxy.so/expo-splash',
      // Shared Oxy native config: android:sharedUserId, iOS keychain group,
      // expo-build-properties defaults, and the shared-identity reader.
      ['@oxy.so/app-preset', {}],
    ],
    extra: {
      router: {},
    },
  },
};
