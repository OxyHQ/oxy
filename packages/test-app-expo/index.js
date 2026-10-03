// The acceptance build is an isolated sibling; normal playground keeps Expo Router.
if (process.env.EXPO_PUBLIC_OXY_NATIVE_ACCEPTANCE === '1') {
  require('./acceptance/entry');
} else {
  require('expo-router/entry');
}
