/**
 * Replaces `process.env.OXY_BUILD_ID` with the build id, in every module the
 * app bundles. babel-preset-expo's own `EXPO_PUBLIC_*` inlining skips
 * node_modules, which is exactly where `@oxy.so/services` reads it.
 */
const { resolveOxyBuildId } = require('../build-id');

module.exports = function inlineOxyBuildId({ types: t }) {
  const buildId = resolveOxyBuildId();
  return {
    name: 'oxy-inline-build-id',
    visitor: {
      MemberExpression(path) {
        if (!path.matchesPattern('process.env.OXY_BUILD_ID')) return;
        if (path.parentPath.isAssignmentExpression({ left: path.node })) return;
        path.replaceWith(t.stringLiteral(buildId));
      },
    },
  };
};
