const fs = require('node:fs');
const path = require('node:path');
const { createOxyMetroConfig } = require('@oxy.so/app-preset/metro');
const config = createOxyMetroConfig(__dirname, { cssInput: './global.css' });
// The published preset assumes a monorepo. This consumer is standalone.
config.watchFolders = [];
config.resolver.nodeModulesPaths = [path.join(__dirname, 'node_modules')];
config.resolver.extraNodeModules = {};
const resolve = config.resolver.resolveRequest;
const root = fs.realpathSync(__dirname) + path.sep;
const seen = new Set();
config.resolver.resolveRequest = (context, name, platform) => {
  const result = resolve(context, name, platform);
  // Expo CLI owns this in-memory module; it is not a filesystem path.
  if (result.type === 'sourceFile' && result.filePath === '\0polyfill:assets-registry'
      && /^@react-native\/assets-registry\/registry(\.js)?$/.test(name)) return result;
  const files = result.type === 'sourceFile' ? [result.filePath] : result.type === 'assetFiles' ? result.filePaths : [];
  for (const file of files) {
    const actual = fs.realpathSync(file);
    if (!actual.startsWith(root)) throw new Error('Registry fixture resolved outside its own directory');
    if (actual.includes(`${path.sep}@oxy.so${path.sep}`) && !seen.has(actual)) {
      seen.add(actual);
      fs.appendFileSync(path.join(__dirname, 'metro-resolved.jsonl'), JSON.stringify({ importer: context.originModulePath, request: name, platform, resolved: actual }) + '\n', { mode: 0o600 });
    }
  }
  return result;
};
module.exports = config;
