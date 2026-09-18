// Standard Oxy Babel config — see @oxy.so/app-preset/babel.
const path = require('path');
const oxyBabelPreset = require('@oxy.so/app-preset/babel');

// Monorepo-workspace-only: Metro compiles @oxy.so/core from SOURCE here, and its
// mixins use TypeScript `declare` class fields, which babel-preset-expo's
// flow-strip pass rejects. Strip them first. Published apps consume core's
// built output and do not need this.
const flowStripTypes = require.resolve('@babel/plugin-transform-flow-strip-types', {
  paths: [path.dirname(require.resolve('babel-preset-expo'))],
});

module.exports = function testAppBabelConfig(api) {
  const config = oxyBabelPreset(api);
  return {
    ...config,
    plugins: [[flowStripTypes, { allowDeclareFields: true }], ...config.plugins],
  };
};
