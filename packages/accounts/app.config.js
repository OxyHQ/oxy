const { oxySplashScreenPlugin } = require('@oxyhq/expo-splash/config');

// App variant — lets a development build sit next to the production app on the
// SAME device by giving it a distinct applicationId/bundleId + name. Build the
// dev variant with `APP_VARIANT=development` (e.g.
// `APP_VARIANT=development npx expo run:android`); production is the default.
const IS_DEV_VARIANT = process.env.APP_VARIANT === 'development';
const APP_ID = IS_DEV_VARIANT ? 'so.oxy.accounts.dev' : 'so.oxy.accounts';
const APP_NAME = IS_DEV_VARIANT ? 'Accounts (Dev)' : 'Accounts by Oxy';

// Registered ApplicationCredential publicKey, used at BUILD time to bake this
// app's Oxy Updates manifest URL into the binary. It must equal the runtime
// value in `constants/oxy.ts` (that file cannot be required from here: it is
// TypeScript and app.config.js is plain CommonJS), so
// `__tests__/updates/app-config-client-id.test.ts` asserts the two agree.
const OXY_CLIENT_ID =
  process.env.EXPO_PUBLIC_OXY_CLIENT_ID ??
  'oxy_dk_00f0e5d5a2e4697740a476d3cfc54f4490f01245d0d2dd05';

// OTA release channel this binary polls. `oxy-ship publish --channel <name>`
// writes to the matching channel.
const OXY_UPDATES_CHANNEL = process.env.EXPO_PUBLIC_OXY_UPDATES_CHANNEL ?? 'production';

module.exports = {
  expo: {
    name: APP_NAME,
    slug: 'Oxy',
    version: '1.0.0',
    orientation: 'portrait',
    icon: './assets/images/icon.png',
    scheme: 'accounts',
    userInterfaceStyle: 'automatic',
    android: {
      adaptiveIcon: {
        backgroundColor: '#E6F4FE',
        foregroundImage: './assets/images/android-icon-foreground.png',
        backgroundImage: './assets/images/android-icon-background.png',
        monochromeImage: './assets/images/android-icon-monochrome.png',
      },
      predictiveBackGestureEnabled: true,
      softwareKeyboardLayoutMode: 'pan',
      permissions: [
        'android.permission.USE_BIOMETRIC',
        'android.permission.USE_FINGERPRINT',
      ],
      package: APP_ID,
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: APP_ID,
      // Shared Keychain Access Group so this app can READ the identity keypair
      // Commons wrote (silent "Sign in with Oxy"). `$(AppIdentifierPrefix)`
      // expands to the Team ID prefix at build; the runtime group string in
      // @oxyhq/core's KeyManager stays `group.so.oxy.shared` (suffix match).
      // Prerequisite: all Oxy iOS apps ship under the SAME Apple Developer Team.
      entitlements: {
        'keychain-access-groups': ['$(AppIdentifierPrefix)group.so.oxy.shared'],
      },
      // iOS 9+ requires every custom scheme this app probes with
      // `Linking.canOpenURL` to be whitelisted here, else the probe always
      // returns false. `oxycommons` lets "Sign in with Oxy" detect an installed
      // Commons and deep-link straight into its approve screen.
      infoPlist: {
        LSApplicationQueriesSchemes: ['oxycommons'],
      },
    },
    web: {
      output: 'static',
      favicon: './assets/images/favicon.png',
    },
    plugins: [
      'expo-router',
      // Native OS splash (Oxy family "Instagram, from Meta" pattern): Accounts'
      // own logo (the Oxy mark as a white silhouette on transparent) centered on
      // the dark brand background, with the shared Oxy symbol pinned to the
      // bottom. `oxySplashScreenPlugin` builds the expo-splash-screen tuple; the
      // bare `@oxyhq/expo-splash` entry (bundled Oxy asset) MUST immediately
      // follow it to add the bottom branding.
      oxySplashScreenPlugin({
        image: './assets/images/splash-logo.png',
        imageWidth: 176,
        backgroundColor: '#0B0B0F',
      }),
      '@oxyhq/expo-splash',
      [
        'expo-local-authentication',
        {
          faceIDPermission:
            'Allow $(PRODUCT_NAME) to use Face ID to protect your identity.',
        },
      ],
      [
        'expo-build-properties',
        {
          android: {
            enableProguardInReleaseBuilds: true,
            enableShrinkResourcesInReleaseBuilds: true,
            useLegacyPackaging: true,
          },
        },
      ],
      'expo-secure-store',
      'expo-font',
      'expo-image',
      'expo-sharing',
      'expo-status-bar',
      'expo-web-browser',
      // Adds android:sharedUserId="so.oxy.shared" so this app shares the same
      // Android keychain namespace as every other Oxy app signed with the
      // shared ecosystem cert — enables sign-in-once-use-everywhere.
      './plugins/withSharedUserId',
      // Requests the signature-level READ_IDENTITY permission + provider queries
      // so this app can READ the shared identity Commons hosts (the native
      // module now ships inside @oxyhq/services). Reader-only: it never hosts
      // the provider.
      '@oxyhq/services/plugins/withSharedIdentityReader',
      // Hosts the signature-protected OxyDeviceSessionProvider for the SHARED
      // DEVICE SESSION credential — a different secret from the identity key, on
      // its own permission and its own encrypted file. Accounts is a hub because
      // it is inside the so.oxy.shared UID, so the file it serves is the one
      // every UID sibling already sees. This is what lets a newly installed
      // official app join the device's session without a QR and without ever
      // reading the Commons private key.
      '@oxyhq/services/plugins/withSharedDeviceSessionProvider',
      // Oxy Updates (OTA). Points expo-updates at this app's manifest endpoint on
      // the self-hosted update server in oxy-api, sets the runtimeVersion policy
      // and wires the ecosystem code-signing certificate. `expo-updates` itself
      // needs no entry here: prebuild applies its config plugin automatically for
      // every installed versioned Expo SDK package.
      [
        '@oxyhq/app-preset/plugin/withOxyUpdates',
        {
          clientId: OXY_CLIENT_ID,
          channel: OXY_UPDATES_CHANNEL,
          ...(process.env.EXPO_PUBLIC_API_URL
            ? { apiOrigin: process.env.EXPO_PUBLIC_API_URL }
            : {}),
        },
      ],
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    extra: {
      router: {},
      eas: {
        projectId: 'b1dd5391-7c83-492a-9312-15ea2a999ddd',
      },
    },
    owner: 'oxyhq',
  },
};
