const { oxySplashScreenPlugin } = require('@oxyhq/expo-splash/config');

// App variant — lets a development build sit next to the production app on the
// SAME device by giving it a distinct applicationId/bundleId + name.
// Build the dev variant with `APP_VARIANT=development` (e.g.
// `APP_VARIANT=development npx expo run:android`); production is the default.
// The URL scheme is intentionally shared, so the deep-link plumbing (the
// `oxycommons://` payloads minted in @oxyhq/core) keeps working unchanged —
// Android just shows an app chooser when both are installed.
const IS_DEV_VARIANT = process.env.APP_VARIANT === 'development';
const APP_ID = IS_DEV_VARIANT ? 'so.oxy.commons.dev' : 'so.oxy.commons';
const APP_NAME = IS_DEV_VARIANT ? 'Commons (Dev)' : 'Commons by Oxy';

// Registered ApplicationCredential publicKey, used at BUILD time to bake this
// app's Oxy Updates manifest URL into the binary. It must equal the runtime
// value in `constants/oxy.ts` (that file cannot be required from here: it is
// TypeScript and app.config.js is plain CommonJS), so
// `__tests__/updates/app-config-client-id.test.ts` asserts the two agree.
const OXY_CLIENT_ID =
  process.env.EXPO_PUBLIC_OXY_CLIENT_ID ??
  'oxy_dk_f65326da2a0d106bf98e873ce19b0ca9094d6c0c1f845a18';

// Channel this binary polls. `production` unless a preview build overrides it;
// `oxy-ship publish --channel <name>` writes to the matching channel.
const OXY_UPDATES_CHANNEL = process.env.EXPO_PUBLIC_OXY_UPDATES_CHANNEL ?? 'production';

module.exports = {
  expo: {
    name: APP_NAME,
    slug: 'commons',
    version: '1.1.0',
    orientation: 'portrait',
    icon: './assets/images/icon.png',
    scheme: ['commons', 'oxycommons'],
    userInterfaceStyle: 'automatic',
    platforms: ['ios', 'android'],
    android: {
      adaptiveIcon: {
        backgroundColor: '#000000',
        foregroundImage: './assets/images/android-icon-foreground.png',
        backgroundImage: './assets/images/android-icon-background.png',
        monochromeImage: './assets/images/android-icon-monochrome.png',
      },
      versionCode: 3,
      predictiveBackGestureEnabled: true,
      softwareKeyboardLayoutMode: 'resize',
      permissions: [
        'android.permission.USE_BIOMETRIC',
        'android.permission.USE_FINGERPRINT',
      ],
      package: APP_ID,
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: APP_ID,
      // Shared Keychain Access Group so the identity keypair is readable by
      // every same-Team Oxy app (silent "Sign in with Oxy"). `$(AppIdentifierPrefix)`
      // expands to the Team ID prefix at build; the runtime group string in
      // @oxyhq/core's KeyManager stays `group.so.oxy.shared` (suffix match).
      // Prerequisite: all Oxy iOS apps ship under the SAME Apple Developer Team.
      entitlements: {
        'keychain-access-groups': ['$(AppIdentifierPrefix)group.so.oxy.shared'],
      },
    },
    plugins: [
      // Re-encodes the generated bitmap resources into real lossless WebP —
      // Expo emits PNG bytes whatever extension it writes. See the plugin
      // header for the @expo/image-utils bug behind it.
      //
      // Registered FIRST so that it RUNS LAST: `withMod`'s `interceptingMod`
      // awaits its own action and only then calls `nextMod` (the previously
      // registered mod), so the mod chain executes in reverse registration
      // order. It has to run after every image generator — `oxySplashScreenPlugin`
      // and `@oxyhq/expo-splash` both write splash bitmaps, and running before
      // them leaves a `.png` and a `.webp` claiming the same resource name.
      '@oxyhq/app-preset/plugin/withOxyAndroidWebp',
      'expo-router',
      // Native OS splash (Oxy family "Instagram, from Meta" pattern): Commons'
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
            // x86/x86_64 only serve emulators and Chromebooks, and Chromebooks
            // translate arm64 anyway. Every configured ABI is compiled and ships
            // in the AAB, so 4 -> 2 ABIs halves that work and payload. Build
            // another ABI without editing this:
            // `./gradlew <task> -PreactNativeArchitectures=x86_64`.
            buildArchs: ['armeabi-v7a', 'arm64-v8a'],
            // Appended to android/app/proguard-rules.pro. Kept deliberately
            // small: react-native, expo-modules-core, reanimated and skia
            // already ship their own rules as consumerProguardFiles inside
            // their AARs, and over-keeping would cancel the R8 optimization
            // that withOxyAndroidRelease turns on.
            extraProguardRules: [
              '# expo-contacts is referenced by the autolinked ExpoModulesPackageList',
              '# but is not a dependency here; suppress R8\'s missing-class error for',
              '# that dead optional reference (it is never loaded at runtime).',
              '-dontwarn expo.modules.contacts.**',
              '',
              '# Readable production stack traces: R8 optimize rewrites line numbers',
              '# when inlining, so without these the traces reaching the Play',
              '# Console point at the wrong code.',
              '-keepattributes SourceFile,LineNumberTable',
              '-renamesourcefileattribute SourceFile',
            ].join('\n'),
          },
        },
      ],
      [
        'expo-camera',
        {
          cameraPermission: 'Allow $(PRODUCT_NAME) to scan sign-in QR codes.',
        },
      ],
      // Android sharedUserId 'so.oxy.shared' — Commons is the identity vault; it
      // must be in the same shared-keychain UID as the other Oxy apps so
      // "Sign in with Oxy" shares the session across apps (requires all Oxy apps
      // to be signed with the same key — the oxy-ecosystem release keystore).
      './plugins/withSharedUserId',
      // Release buildType bits expo-build-properties cannot express: the R8
      // -optimize proguard file, and the real release signing config
      // (credentials come from Gradle properties, never the repo). Commons
      // shares the so.oxy.shared UID, so the artefact MUST carry the shared Oxy
      // ecosystem certificate — verify it, never assume it.
      '@oxyhq/app-preset/plugin/withOxyAndroidRelease',
      // Hosts the signature-protected OxyIdentityProvider (the native module
      // now ships inside @oxyhq/services) that lets same-key Oxy apps read the
      // shared identity keypair Commons writes. Commons is the ONLY app that
      // hosts it.
      '@oxyhq/services/plugins/withSharedIdentityProvider',
      // Also hosts the OxyDeviceSessionProvider — a SEPARATE provider, permission
      // and encrypted file for the shared DEVICE SESSION credential. Commons is
      // identity-bound and never publishes into that slot itself; it hosts the
      // provider because, as a member of the so.oxy.shared UID, it serves the
      // same file its UID siblings write, so a same-signature app outside the UID
      // can join the device session even when Accounts is not installed.
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
      'expo-secure-store',
      'expo-font',
      'expo-image',
      'expo-sharing',
      'expo-status-bar',
      'expo-web-browser',
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    extra: {
      router: {},
      eas: {
        projectId: '',
      },
    },
    owner: 'oxyhq',
  },
};
