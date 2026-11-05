const { getDefaultConfig } = require('expo/metro-config');

/**
 * Expo 54's Metro config, plus the macOS platform the way Astro bundles it:
 * `react-native` (and its deep paths) resolved to react-native-macos, and the
 * `react-native` export condition, which @react-native/metro-config sets.
 */
const config = getDefaultConfig(__dirname);
config.resolver.platforms = [...config.resolver.platforms, 'macos'];
config.resolver.unstable_conditionsByPlatform = {
  ...config.resolver.unstable_conditionsByPlatform,
  macos: ['react-native'],
};
config.resolver.resolveRequest = (context, moduleName, platform) =>
  context.resolveRequest(
    context,
    platform === 'macos' && /^react-native($|\/)/.test(moduleName)
      ? moduleName.replace(/^react-native/, 'react-native-macos')
      : moduleName,
    platform,
  );

module.exports = config;
