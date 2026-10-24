// Oxy Console is web-only: a static Expo export served by the `oxy-console`
// Worker at console.oxy.so (see wrangler.toml). No native projects.
module.exports = {
  expo: {
    name: 'Oxy Console',
    slug: 'oxy-console',
    version: '1.0.0',
    scheme: 'oxyconsole',
    userInterfaceStyle: 'automatic',
    web: {
      bundler: 'metro',
      output: 'single',
      favicon: './public/favicon.ico',
    },
    plugins: [
      ['expo-router', { asyncRoutes: { web: 'production' } }],
      'expo-font',
      'expo-web-browser',
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
      // Expo's oxc transformer, about 2x faster cold bundles than Babel. Development
      // only: in a production export it keeps the requires of dead platform branches
      // (`if (Platform.OS !== 'web') require(...)`), pulling native-only packages into
      // the web bundle. The CLI sets NODE_ENV before it reads this config.
      noxcturnalTransformWorker: process.env.NODE_ENV !== 'production',
    },
    owner: 'oxyhq',
  },
};
