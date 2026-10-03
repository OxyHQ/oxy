module.exports = {
  expo: {
    name: 'Oxy 1519 Identity Recovery',
    slug: 'oxy-1519-identity-recovery',
    version: '1.0.0',
    android: { package: 'so.oxy.commons.dev' },
    updates: { enabled: false },
    plugins: [
      'expo-font',
      'expo-secure-store',
      './acceptance/withObserver',
      ['@oxy.so/app-preset', { keychainGroup: false, android: { usesCleartextTraffic: true } }],
      './plugins/withOxyIdentityHost',
      '@oxy.so/services/plugins/withSharedDeviceSessionProvider',
    ],
  },
};
