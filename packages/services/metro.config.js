const { getDefaultConfig } = require('metro-config');

/**
 * Metro configuration for @oxy.so/services
 * This ensures proper React resolution to avoid ReactCurrentDispatcher errors
 */
module.exports = (async () => {
  const config = await getDefaultConfig();

  return {
    ...config,
    resolver: {
      ...config.resolver,
      // Ensure React is resolved from the consuming app's node_modules
      // This prevents multiple React versions and ReactCurrentDispatcher errors
      resolveRequest: (context, moduleName, platform) => {
        // For React and React-related modules, always resolve from the app's node_modules
        if (moduleName === 'react' ||
            moduleName === 'react/jsx-runtime' ||
            moduleName === 'react/jsx-dev-runtime' ||
            moduleName.startsWith('react/')) {
          // Let Metro resolve these from the app's dependencies
          return context.resolveRequest(context, moduleName, platform);
        }

        // For other modules, use default resolution
        return context.resolveRequest(context, moduleName, platform);
      },

      // Additional resolver options to prevent conflicts
      alias: {
        // Ensure React is always resolved from the same location
        'react': require.resolve('react'),
        'react/jsx-runtime': require.resolve('react/jsx-runtime'),
        'react/jsx-dev-runtime': require.resolve('react/jsx-dev-runtime'),
      },

      // Blacklist nested node_modules to prevent React version conflicts
      blacklistRE: /node_modules\/.*\/node_modules\/react\/.*/,
    },
  };
})();
