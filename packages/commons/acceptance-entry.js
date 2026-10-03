if (process.env.EXPO_PUBLIC_OXY_IDENTITY_RECOVERY === '1') {
  require('./acceptance/entry');
} else {
  require('expo-router/entry');
}
