const assert = require('node:assert/strict');
const path = require('node:path');
const { after, before, test } = require('node:test');
const Module = require('node:module');

const originalLoad = Module._load;
let createOxyMetroConfig;

before(() => {
  Module._load = function load(request, parent, isMain) {
    if (request === 'expo/metro-config') {
      return {
        getDefaultConfig() {
          return {
            resolver: {
              assetExts: ['png', 'svg', 'woff'],
              sourceExts: ['js', 'ts'],
              extraNodeModules: { existing: '/existing' },
              resolveRequest: (context, moduleName, platform) => ({ context, moduleName, platform }),
            },
            transformer: { minifierConfig: { compress: { existing: true } } },
          };
        },
      };
    }
    if (request === 'nativewind/metro') {
      return {
        withNativeWind(config, options) {
          config.nativeWindOptions = options;
          return config;
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };
  ({ createOxyMetroConfig } = require('../metro'));
});

after(() => {
  Module._load = originalLoad;
});

test('configures optional SVG, aliases, watch roots and minifier policy', () => {
  const projectRoot = '/repo/packages/frontend';
  const config = createOxyMetroConfig(projectRoot, {
    cssInput: './styles/global.css',
    dropConsole: true,
    svgTransformerPath: '/transformers/svg.js',
    extraNodeModules: { '@app/assets': '/repo/assets' },
    extraWatchFolders: ['/repo/generated'],
    extraAssetExts: ['bin', 'woff2'],
    extraSourceExts: ['cjs', 'ts'],
  });

  assert.deepEqual(config.watchFolders, ['/repo', '/repo/generated']);
  assert.equal(config.transformer.babelTransformerPath, '/transformers/svg.js');
  assert.equal(config.transformer.minifierConfig.compress.drop_console, true);
  assert.deepEqual(config.resolver.assetExts, ['png', 'woff', 'wasm', 'woff2', 'bin']);
  assert.deepEqual(config.resolver.sourceExts, ['js', 'ts', 'tsx', 'svg', 'cjs']);
  assert.equal(config.resolver.extraNodeModules['@app/assets'], '/repo/assets');
  assert.equal(config.nativeWindOptions.input, './styles/global.css');
});

test('anchors README blocking and converts extra path blocks to escaped regexes', () => {
  const extraRoot = '/repo/.claude/worktrees';
  const config = createOxyMetroConfig('/repo/packages/frontend', { extraBlockList: [extraRoot] });
  const isBlocked = (candidate) => config.resolver.blockList.some((pattern) => pattern.test(candidate));

  assert.equal(isBlocked('/repo/packages/frontend/README'), true);
  assert.equal(isBlocked('/repo/packages/frontend/README.md'), true);
  assert.equal(isBlocked('/repo/packages/README-generator/index.js'), false);
  assert.equal(isBlocked('/repo/.claude/worktrees/a/node_modules/react/index.js'), true);
});

test('does not block a project whose checkout lives inside a worktrees directory', () => {
  const projectRoot = '/repo/.worktrees/feature/packages/frontend';
  const config = createOxyMetroConfig(projectRoot);
  const isBlocked = (candidate) => config.resolver.blockList.some((pattern) => pattern.test(candidate));

  assert.equal(isBlocked('/repo/.worktrees/feature/node_modules/expo-router/entry.js'), false);
  assert.equal(isBlocked('/repo/.worktrees/feature/.worktrees/sibling/node_modules/react/index.js'), true);
});

test('keeps svg as an asset and console calls by default', () => {
  const config = createOxyMetroConfig(path.resolve('/repo/packages/frontend'));
  assert.equal(config.resolver.assetExts.includes('svg'), true);
  assert.equal(config.resolver.sourceExts.includes('svg'), false);
  assert.equal(config.transformer.minifierConfig.compress.drop_console, false);
});
