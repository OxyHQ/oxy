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
    plugins: [['expo-router', { asyncRoutes: { web: 'production' } }], 'expo-font', 'expo-web-browser'],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    owner: 'oxyhq',
  },
};
