const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const Module = require('node:module');

const originalLoad = Module._load;
let createOxyMetroConfig;
let findWorkspaceRoot;
/** Configs worklets' `getBundleModeMetroConfig` was handed. */
const bundleModeWrapped = [];

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
              resolveRequest: (context, moduleName, platform) => ({
                context,
                moduleName,
                platform,
              }),
            },
            transformer: { minifierConfig: { compress: { existing: true } } },
          };
        },
      };
    }
    if (request.replace(/\\/g, '/').includes('react-native-worklets/bundleMode')) {
      return {
        getBundleModeMetroConfig(config) {
          bundleModeWrapped.push(config);
          config.workletsBundleMode = true;
          return config;
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
  ({ createOxyMetroConfig, findWorkspaceRoot } = require('../metro'));
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
    workspaceRoot: '/repo',
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
  const isBlocked = (candidate) =>
    config.resolver.blockList.some((pattern) => pattern.test(candidate));

  assert.equal(isBlocked('/repo/packages/frontend/README'), true);
  assert.equal(isBlocked('/repo/packages/frontend/README.md'), true);
  assert.equal(isBlocked('/repo/packages/README-generator/index.js'), false);
  assert.equal(isBlocked('/repo/.claude/worktrees/a/node_modules/react/index.js'), true);
});

test('does not block a project whose checkout lives inside a worktrees directory', () => {
  const projectRoot = '/repo/.worktrees/feature/packages/frontend';
  const config = createOxyMetroConfig(projectRoot, { workspaceRoot: '/repo/.worktrees/feature' });
  const isBlocked = (candidate) =>
    config.resolver.blockList.some((pattern) => pattern.test(candidate));

  assert.equal(isBlocked('/repo/.worktrees/feature/node_modules/expo-router/entry.js'), false);
  assert.equal(
    isBlocked('/repo/.worktrees/feature/.worktrees/sibling/node_modules/react/index.js'),
    true,
  );
});

test('blocks caches and tests inside the project, never a checkout that lives under one', () => {
  const blocked = (projectRoot, options) => {
    const config = createOxyMetroConfig(projectRoot, options);
    return (candidate) => config.resolver.blockList.some((pattern) => pattern.test(candidate));
  };

  // A worktree under ~/.cache (or any `.cache`, `.expo`, `.metro`, `__tests__`
  // ancestor): its own files bundle.
  for (const home of [
    '/home/me/.cache',
    '/x/.expo',
    '/x/.expo-shared',
    '/x/.metro',
    '/x/__tests__',
  ]) {
    const isBlocked = blocked(`${home}/app/wt/packages/frontend`, {
      workspaceRoot: `${home}/app/wt`,
    });
    assert.equal(isBlocked(`${home}/app/wt/node_modules/expo-router/entry.js`), false, home);
    assert.equal(isBlocked(`${home}/app/wt/packages/frontend/app/_layout.tsx`), false, home);
    // …and the caches and tests INSIDE it are still blocked.
    assert.equal(isBlocked(`${home}/app/wt/.cache/babel/x.json`), true, home);
    assert.equal(isBlocked(`${home}/app/wt/node_modules/.cache/metro/x.json`), true, home);
    assert.equal(isBlocked(`${home}/app/wt/packages/frontend/.expo/types/router.d.ts`), true, home);
    assert.equal(
      isBlocked(`${home}/app/wt/packages/frontend/.expo-shared/assets.json`),
      true,
      home,
    );
    assert.equal(isBlocked(`${home}/app/wt/packages/frontend/.metro/x.js`), true, home);
    assert.equal(isBlocked(`${home}/app/wt/packages/frontend/lib/__tests__/a.ts`), true, home);
  }

  // An extra watch folder outside the monorepo gets the same rule.
  const isBlocked = blocked('/repo/packages/frontend', {
    extraWatchFolders: ['/shared/kit'],
    workspaceRoot: '/repo',
  });
  assert.equal(isBlocked('/shared/kit/.cache/x.json'), true);
  assert.equal(isBlocked('/shared/kit/src/index.ts'), false);
  // A path outside every root is not this list's business.
  assert.equal(isBlocked('/elsewhere/.cache/x.json'), false);
});

test('watches the install root of the checkout, never the directory above it', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oxy-metro-root-')));
  const put = (file, content = '') => {
    fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
    fs.writeFileSync(path.join(home, file), content);
  };
  const workspaces = JSON.stringify({ workspaces: ['packages/*'] });
  try {
    // ~/Oxy/<repo>: a single-package app beside a sibling worktree. `../..` was home.
    put('Oxy/Single/.git/HEAD');
    put('Oxy/Single/bun.lock');
    put('Oxy/Single/package.json', '{}');
    put('Oxy/Single-wt/.git', 'gitdir: x');
    const single = path.join(home, 'Oxy/Single');
    assert.equal(findWorkspaceRoot(single), single);
    assert.deepEqual(createOxyMetroConfig(single).watchFolders, [single]);

    // A monorepo app resolves to the workspaces root, even with a stray lockfile of its own.
    put('Oxy/Mono/.git/HEAD');
    put('Oxy/Mono/package.json', workspaces);
    put('Oxy/Mono/packages/frontend/package.json', '{}');
    put('Oxy/Mono/packages/frontend/bun.lock');
    const mono = path.join(home, 'Oxy/Mono');
    const config = createOxyMetroConfig(path.join(mono, 'packages/frontend'));
    assert.deepEqual(config.watchFolders, [mono]);
    assert.equal(
      config.resolver.blockList.some((p) =>
        p.test(`${mono}/.claude/worktrees/a/node_modules/x.js`),
      ),
      true,
    );

    // A worktree nested inside it (`.git` is a file) is its own root.
    put('Oxy/Mono/.claude/worktrees/a/.git', 'gitdir: x');
    put('Oxy/Mono/.claude/worktrees/a/package.json', workspaces);
    const nested = path.join(mono, '.claude/worktrees/a');
    assert.equal(findWorkspaceRoot(path.join(nested, 'packages/frontend')), nested);

    // Nothing marks a root: the project itself, never an ancestor.
    put('loose/app/package.json', '{}');
    assert.equal(findWorkspaceRoot(path.join(home, 'loose/app')), path.join(home, 'loose/app'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('keeps svg as an asset and console calls by default', () => {
  const config = createOxyMetroConfig(path.resolve('/repo/packages/frontend'));
  assert.equal(config.resolver.assetExts.includes('svg'), true);
  assert.equal(config.resolver.sourceExts.includes('svg'), false);
  assert.equal(config.transformer.minifierConfig.compress.drop_console, false);
});

test('stamps the build id into the env the SDK reads and into the transform cache key', () => {
  const saved = {
    id: process.env.OXY_BUILD_ID,
    env: process.env.NODE_ENV,
    sha: process.env.GITHUB_SHA,
  };
  try {
    delete process.env.OXY_BUILD_ID;
    process.env.NODE_ENV = 'production';
    process.env.GITHUB_SHA = 'abc123';
    const config = createOxyMetroConfig('/repo/packages/frontend');
    assert.equal(process.env.OXY_BUILD_ID, 'abc123');
    assert.match(config.cacheVersion, /oxy-build:abc123/);

    delete process.env.OXY_BUILD_ID;
    process.env.NODE_ENV = 'development';
    assert.match(
      createOxyMetroConfig('/repo/packages/frontend').cacheVersion,
      /oxy-build:development/,
    );
  } finally {
    for (const [key, value] of [
      ['OXY_BUILD_ID', saved.id],
      ['NODE_ENV', saved.env],
      ['GITHUB_SHA', saved.sha],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Bundle Mode is opt-in, and wraps the finished config last', () => {
  const projectRoot = '/repo/packages/frontend';
  bundleModeWrapped.length = 0;
  const plain = createOxyMetroConfig(projectRoot);
  assert.equal(plain.workletsBundleMode, undefined);
  assert.equal(bundleModeWrapped.length, 0);

  const config = createOxyMetroConfig(projectRoot, { workletsBundleMode: true });
  assert.equal(config.workletsBundleMode, true);
  assert.deepEqual(bundleModeWrapped, [config]);
  // What worklets wraps is the finished config: Bloom's resolver (and its
  // web `ws` shim) is already in it, for worklets' resolver to hand down to.
  assert.deepEqual(config.resolver.resolveRequest({}, 'ws', 'web'), { type: 'empty' });
});
