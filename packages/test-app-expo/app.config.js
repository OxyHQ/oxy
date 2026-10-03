const base = require('./app.json').expo;
const siblings = {
  mention: { name: 'Oxy 1519 Mention peer', package: 'earth.mention.app.dev' },
  allo: { name: 'Oxy 1519 Allo peer', package: 'com.allo.app.dev' },
};
module.exports = () => {
  if (process.env.EXPO_PUBLIC_OXY_NATIVE_ACCEPTANCE !== '1') return base;
  const variant = process.env.EXPO_PUBLIC_OXY_NATIVE_SIBLING;
  const sibling = Object.hasOwn(siblings, variant ?? '') ? siblings[variant] : null;
  if (!sibling) throw new Error('Select the owned mention or allo acceptance sibling');
  return {
    ...base,
    name: sibling.name,
    slug: `oxy-1519-native-${variant}`,
    scheme: undefined,
    android: { ...base.android, package: sibling.package },
    plugins: base.plugins.map((plugin) => Array.isArray(plugin) && plugin[0] === '@oxy.so/app-preset'
      ? [plugin[0], { keychainGroup: false, android: { usesCleartextTraffic: true } }]
      : plugin),
  };
};
