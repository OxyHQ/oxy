const { oxySplashScreenPlugin } = require('@oxy.so/expo-splash/config');
const { resolvePushConfig } = require('./push-config');

// App variant — lets a development build sit next to the production app on the
// SAME device by giving it a distinct applicationId/bundleId + name.
// Build the dev variant with `APP_VARIANT=development` (e.g.
// `APP_VARIANT=development npx expo run:android`); production is the default.
// The URL scheme is intentionally shared, so the deep-link plumbing (the
// `oxycommons://` payloads minted in @oxy.so/core) keeps working unchanged —
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

// Push: the EAS project id and Firebase's google-services.json come from the
// build environment, never the repo (see push-config.js for what to provide).
const PUSH = resolvePushConfig({ packageName: APP_ID });

// Channel this binary polls. `production` unless a preview build overrides it;
// `oxy-ship publish --channel <name>` writes to the matching channel.
const OXY_UPDATES_CHANNEL = process.env.EXPO_PUBLIC_OXY_UPDATES_CHANNEL ?? 'production';

module.exports = {
  expo: {
    name: APP_NAME,
    slug: 'commons',
    // The OTA compatibility boundary (withOxyUpdates sets runtimeVersion
    // policy 'appVersion'): bump it whenever the native layer changes, so a
    // binary built from older native code never receives JS that needs newer
    // native modules. 1.2.0 is the first Expo SDK 58 build; 1.3.0 links
    // expo-image-picker and expo-clipboard; 1.4.0 is the first binary that
    // verifies Oxy Updates signatures (the certificate is baked in), so no
    // update is ever published for a runtime that would run it unverified.
    version: '1.4.0',
    orientation: 'portrait',
    icon: './assets/images/icon.png',
    // `oxycommons` FIRST: it is the scheme every approve / card / attest /
    // link payload is minted with (`@oxy.so/core`, the API), and expo-linking
    // builds this app's own URLs from the first entry ("Using 'commons'" was
    // logged on device). `commons` stays registered for older links.
    scheme: ['oxycommons', 'commons'],
    userInterfaceStyle: 'automatic',
    platforms: ['ios', 'android'],
    // Native-only, but Expo Router 58 defaults an unset `web.output` to
    // "server", which `expo export` (EAS Update bundles included) acts on.
    // Pin the pre-58 single-page value so nothing server-side is attempted.
    web: { output: 'single' },
    android: {
      adaptiveIcon: {
        backgroundColor: '#000000',
        foregroundImage: './assets/images/android-icon-foreground.png',
        backgroundImage: './assets/images/android-icon-background.png',
        monochromeImage: './assets/images/android-icon-monochrome.png',
      },
      versionCode: 5,
      ...(PUSH.googleServicesFile ? { googleServicesFile: PUSH.googleServicesFile } : {}),
      predictiveBackGestureEnabled: true,
      softwareKeyboardLayoutMode: 'resize',
      permissions: ['android.permission.USE_BIOMETRIC', 'android.permission.USE_FINGERPRINT'],
      // `expo-screen-capture` (the recovery-phrase capture guard) declares
      // READ_MEDIA_IMAGES in its library manifest for its screenshot LISTENER,
      // which Commons does not use. It is a Play "photo and video" permission
      // that needs a policy declaration, so it is stripped from the merged
      // manifest. DETECT_SCREEN_CAPTURE stays: it is a normal permission, and
      // the module registers its Android 14+ capture callback on create.
      blockedPermissions: ['android.permission.READ_MEDIA_IMAGES'],
      package: APP_ID,
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: APP_ID,
      // Shared Keychain Access Group so the identity keypair is readable by
      // every same-Team Oxy app (silent "Sign in with Oxy"). `$(AppIdentifierPrefix)`
      // expands to the Team ID prefix at build; the runtime group string in
      // @oxy.so/core's KeyManager stays `group.so.oxy.shared` (suffix match).
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
      // and `@oxy.so/expo-splash` both write splash bitmaps, and running before
      // them leaves a `.png` and a `.webp` claiming the same resource name.
      '@oxy.so/app-preset/plugin/withOxyAndroidWebp',
      'expo-router',
      // Native OS splash (Oxy family "Instagram, from Meta" pattern): Commons'
      // own logo (the Oxy mark as a white silhouette on transparent) centered on
      // the dark brand background, with the shared Oxy symbol pinned to the
      // bottom. `oxySplashScreenPlugin` builds the expo-splash-screen tuple; the
      // bare `@oxy.so/expo-splash` entry (bundled Oxy asset) MUST immediately
      // follow it to add the bottom branding.
      oxySplashScreenPlugin({
        image: './assets/images/splash-logo.png',
        imageWidth: 176,
        backgroundColor: '#0B0B0F',
      }),
      '@oxy.so/expo-splash',
      [
        'expo-local-authentication',
        {
          faceIDPermission: 'Allow $(PRODUCT_NAME) to use Face ID to protect your identity.',
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
            // their AARs, and over-keeping would cancel R8's optimization
            // (the template's proguard-android-optimize.txt).
            extraProguardRules: [
              '# expo-contacts is referenced by the autolinked ExpoModulesPackageList',
              "# but is not a dependency here; suppress R8's missing-class error for",
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
      // The SDK's account surface (Settings > Manage account) changes the
      // profile picture through expo-image-picker, and its authenticator and
      // app-info screens copy through expo-clipboard. Both are OPTIONAL peers of
      // @oxy.so/services, and Expo autolinking skips optional peers, so without
      // these direct dependencies the release had neither native module: the
      // photo library said it was unavailable and copy did nothing. No
      // microphone: Commons never records video.
      [
        'expo-image-picker',
        {
          photosPermission: 'Allow $(PRODUCT_NAME) to choose a profile picture from your photos.',
          cameraPermission: 'Allow $(PRODUCT_NAME) to take a profile picture.',
          microphonePermission: false,
        },
      ],
      // Every Oxy app declares AND requests so.oxy.permission.IDENTITY and
      // so.oxy.permission.DEVICE_SESSION (signature level) and queries the host
      // authorities. No Oxy app shares a UID: identity and session cross apps
      // only through the providers below. It also signs the release with the ONE
      // ecosystem key (OXY_UPLOAD_* Gradle properties, never the repo) and fails
      // a release whose certificate is not that one: the other Oxy apps reach
      // Commons through signature permissions.
      '@oxy.so/services/plugins/withOxySharedPermissions',
      // The identity host (modules/oxy-identity-host): Commons is the ONLY
      // holder of the identity private key, and this provider answers the other
      // Oxy apps with the public key, challenge proofs and scoped derivations —
      // never the key.
      './plugins/withOxyIdentityHost',
      // The device-session host: the shared DeviceSession credential (a
      // separate provider, permission and encrypted file from the identity).
      // Commons never publishes into it itself (it boots identity-bound); it
      // hosts it so a device with Commons and no Accounts still has one place
      // every Oxy app joins the device session through.
      '@oxy.so/services/plugins/withSharedDeviceSessionProvider',
      // Oxy Updates (OTA). Points expo-updates at this app's manifest endpoint on
      // the self-hosted update server in oxy-api, sets the runtimeVersion policy
      // and wires the ecosystem code-signing certificate. `expo-updates` itself
      // needs no entry here: prebuild applies its config plugin automatically for
      // every installed versioned Expo SDK package.
      [
        '@oxy.so/app-preset/plugin/withOxyUpdates',
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
      // Expo's oxc transformer, about 2x faster cold bundles than Babel. Development
      // only: in a production export it keeps the requires of dead platform branches
      // (`if (Platform.OS !== 'web') require(...)`), pulling native-only packages into
      // the web bundle. The CLI sets NODE_ENV before it reads this config.
      noxcturnalTransformWorker: process.env.NODE_ENV !== 'production',
    },
    extra: {
      router: {},
      eas: {
        // Read by the SDK's getExpoPushToken; `undefined` when not provided,
        // never a placeholder that would mint nothing.
        projectId: PUSH.easProjectId,
      },
    },
    owner: 'oxyhq',
  },
};
