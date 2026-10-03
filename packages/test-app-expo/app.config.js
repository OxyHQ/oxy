const base = require('./app.json').expo;

module.exports = () => {
  if (process.env.EXPO_PUBLIC_OXY_NATIVE_ACCEPTANCE !== '1') return base;
  return {
    ...base,
    name: 'Oxy 1519 Acceptance',
    slug: 'oxy-1519-native-acceptance',
    scheme: 'astro',
    android: { ...base.android, package: 'so.oxy.acceptance1519' },
    plugins: base.plugins.map((plugin) => Array.isArray(plugin) && plugin[0] === '@oxy.so/app-preset'
      ? [plugin[0], { keychainGroup: false, android: { usesCleartextTraffic: true } }]
      : plugin),
  };
};
