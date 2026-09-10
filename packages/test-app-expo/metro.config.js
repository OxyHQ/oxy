const { createOxyMetroConfig } = require('@oxy.so/app-preset/metro');
const path = require('path');

// Base config from the shared Oxy preset (monorepo watch folders, block list,
// symlink + package-exports resolution, web-font/wasm asset exts, minifier,
// NativeWind). See @oxy.so/app-preset/metro.
const config = createOxyMetroConfig(__dirname, {
  cssInput: './global.css',
});

// --- Monorepo-workspace-only additions (a published standalone app does NOT
// need these — they exist because test-app-expo consumes @oxy.so/core /
// @oxy.so/services from workspace SOURCE and coexists with a duplicated Bloom).

const servicesRoot = path.resolve(__dirname, '..', 'services');
const coreRoot = path.resolve(__dirname, '..', 'core');

// Resolve the local SDK packages to their TypeScript source so edits hot-reload.
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  '@oxy.so/core': path.resolve(coreRoot, 'src', 'index.ts'),
  '@oxy.so/services': path.resolve(servicesRoot, 'src', 'index.ts'),
  '@oxy.so/services/ui': path.resolve(servicesRoot, 'src', 'ui'),
};

// Force @oxy.so/bloom to a SINGLE physical instance. In this monorepo Bloom is
// duplicated under the hoisted root node_modules and test-app-expo's own
// node_modules; each copy makes its own React Context, so <BloomThemeProvider>
// from OxyProvider (services' bloom) would not satisfy useTheme() in app code
// (app's bloom). Rewriting the origin module path pins every @oxy.so/bloom import
// to this package's local install.
const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@oxy.so/bloom' || moduleName.startsWith('@oxy.so/bloom/')) {
    const rewrittenContext = {
      ...context,
      originModulePath: path.join(__dirname, 'package.json'),
    };
    if (originalResolveRequest) {
      return originalResolveRequest(rewrittenContext, moduleName, platform);
    }
    return context.resolveRequest(rewrittenContext, moduleName, platform);
  }
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
