/**
 * What `import … from 'react-native'` resolves to on native under the preset,
 * wherever NativeWind would have sent it to `react-native-css/components`.
 *
 * NativeWind's resolver (`globalClassNamePolyfill`) redirects every
 * `react-native` import outside React Native itself to that shim, which
 * re-exports a FIXED list of React Native's API: the components it wraps for
 * `className`, and a getter per remaining name. A name React Native adds and the
 * list lacks reads as `undefined`. React Native 0.88 added `AssetRegistry`;
 * Expo SDK 58's `expo-asset` imports it from 'react-native', so every
 * `useFonts` failed (`Cannot read property 'getAssetByID' of undefined`) and a
 * release build sat on a blank screen with no visible error.
 *
 * This module is that shim plus every name of React Native's runtime index it
 * does not define. The shim's own properties are copied as they are (the same
 * getters), so every component NativeWind wraps, and every name it lists,
 * behaves exactly as before; a missing name forwards to React Native's.
 * Nothing is read until it is used: React Native's index is an object of
 * getters, and only property NAMES are enumerated here.
 *
 * `withCompleteReactNative` (`./index.js`) routes both requires below past
 * NativeWind: the first to the real shim, the second to the real React Native.
 */
const css = require('react-native-css/components');
const reactNative = require('react-native');

const completed = {};

for (const key of Object.getOwnPropertyNames(css)) {
  Object.defineProperty(completed, key, Object.getOwnPropertyDescriptor(css, key));
}

for (const key of Object.getOwnPropertyNames(reactNative)) {
  if (Object.hasOwn(completed, key)) continue;
  Object.defineProperty(completed, key, {
    configurable: true,
    enumerable: Object.getOwnPropertyDescriptor(reactNative, key).enumerable,
    get() {
      return reactNative[key];
    },
  });
}

module.exports = completed;
