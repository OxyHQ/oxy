/**
 * The modules a react-native-macos app does not have: every Expo module whose
 * podspec declares no `:osx` platform (Expo SDK 54), and the SDK's own
 * iOS/Android-only modules (Astro excludes @oxy.so/services from autolinking).
 * jest-expo mocks every Expo module as present; this takes these away again, so
 * `requireNativeModule` throws and `requireOptionalNativeModule` answers null,
 * exactly as they do in the app.
 */
const ABSENT_ON_MACOS = new Set([
  'ExpoAppIntegrity',
  'ExpoBlurView',
  'ExpoClipboard',
  'ExpoDocumentPicker',
  'ExpoHaptics',
  'ExpoImage',
  'ExpoImageManipulator',
  'ExpoLinearGradient',
  'ExpoSecureStore',
  'ExpoVideo',
  'ExponentImagePicker',
  'ExpoBackgroundNotificationTasksModule',
  'ExpoBadgeModule',
  'ExpoNotificationCategoriesModule',
  'ExpoNotificationChannelGroupManager',
  'ExpoNotificationChannelManager',
  'ExpoNotificationPermissionsModule',
  'ExpoNotificationPresenter',
  'ExpoNotificationScheduler',
  'ExpoNotificationsEmitter',
  'ExpoNotificationsHandlerModule',
  'ExpoPushTokenManager',
  'NotificationsServerRegistrationModule',
  'OxyIdentity',
  'OxyDeviceSession',
  'OxyBackgroundSession',
]);

const core = require('expo-modules-core');
const { requireNativeModule, requireOptionalNativeModule } = core;
const requested = new Set();
globalThis.__absentNativeModulesRequested = requested;

core.requireOptionalNativeModule = (name) => {
  if (ABSENT_ON_MACOS.has(name)) {
    requested.add(name);
    return null;
  }
  return requireOptionalNativeModule(name);
};
core.requireNativeModule = (name) => {
  if (ABSENT_ON_MACOS.has(name)) {
    requested.add(name);
    throw new Error(`Cannot find native module '${name}'`);
  }
  return requireNativeModule(name);
};
