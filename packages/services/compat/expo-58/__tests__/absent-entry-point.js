/**
 * A React Native entry point react-native-macos 0.83 does not ship (`react-native/setup-env`, new
 * in 0.87): requiring it fails, as resolving it fails in Astro's Metro, so a caller takes its own
 * fallback (expo's `setupReactNativeEnvironment` loads `InitializeCore`).
 */
throw new Error('This React Native entry point is not in react-native-macos 0.83');
