const path = require('node:path');
const { requireFromProject } = require('../../plugin/requireFromProject');

/** Opt-in compatibility adapter for Expo's static document/app render boundary. */
function withStaticHydrationBoundary(config, projectRoot) {
  const { version } = requireFromProject('@expo/router-server/package.json', projectRoot);
  if (!/^58\.0\.(14|15|16)$/.test(version)) {
    throw new Error(
      `[@oxy.so/app-preset] staticHydrationBoundary supports @expo/router-server 58.0.14–58.0.16; found ${version}. Review the upstream renderer before extending this range.`,
    );
  }
  const adapter = path.join(__dirname, 'renderer.js');
  const parent = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    const resolved = parent(context, moduleName, platform);
    if (
      platform === 'web' &&
      context.customResolverOptions?.environment === 'node' &&
      context.originModulePath !== adapter &&
      resolved.type === 'sourceFile' &&
      /[/\\]@expo[/\\]router-server[/\\]build[/\\]server[/\\]renderStreamingContent\.js$/.test(
        resolved.filePath,
      )
    ) {
      return { type: 'sourceFile', filePath: adapter };
    }
    return resolved;
  };
  return config;
}

module.exports = { withStaticHydrationBoundary };
