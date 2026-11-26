import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderApp, templateLayers } from '../layers';
import { LANGUAGE_OXY_VERSIONS, VERSIONS } from '../versions';

/**
 * The language template (`--language`): a frontend written in the Bloom
 * language on Bloom without NativeWind. These read a fully rendered app, the
 * way the CLI writes it. Installing it, typechecking it and running its Jest
 * suite against packed packages is `scripts/verify-language-app.mjs`.
 */

const config = {
  name: 'Notes App',
  slug: 'notes-app',
  scheme: 'notesapp',
  bundleId: 'com.example.notesapp',
  domain: 'api.example.com',
  backend: true,
  deploy: true,
  demo: true,
  language: true,
  install: false,
  git: false,
  register: false,
};

let dir: string;
let frontend: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oxy-scaffold-language-'));
  await renderApp({ ...config, targetDir: dir });
  frontend = path.join(dir, 'packages', 'frontend');
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const read = (...segments: string[]) => fs.readFile(path.join(frontend, ...segments), 'utf8');

interface Manifest {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  overrides?: Record<string, string>;
  resolutions?: Record<string, string>;
}

const manifest = async (...segments: string[]) =>
  JSON.parse(await fs.readFile(path.join(dir, ...segments, 'package.json'), 'utf8')) as Manifest;

/** Every file under `root`, relative to it. */
async function filesUnder(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)));
}

describe('the layers', () => {
  test('a language app renders base and the language frontend, never the JSX one or its demo', () => {
    expect(templateLayers(config)).toEqual(['base', 'language', 'backend', 'deploy']);
    expect(templateLayers({ ...config, language: false })).toEqual([
      'base',
      'jsx',
      'backend',
      'deploy',
      'demo',
    ]);
  });

  test('no token is left unrendered', async () => {
    for (const file of await filesUnder(dir)) {
      if (/\.(png|jpg)$/.test(file)) continue;
      const content = await fs.readFile(path.join(dir, file), 'utf8');
      expect({ file, token: /(?<!\$)\{\{[A-Za-z0-9_.#/^ ]+\}\}/.test(content) }).toEqual({
        file,
        token: false,
      });
    }
  });
});

describe('no NativeWind', () => {
  test('no NativeWind, Tailwind or react-native-css file is shipped', () => {
    for (const file of ['global.css', 'postcss.config.mjs', 'nativewind-env.d.ts']) {
      expect({ file, exists: existsSync(path.join(frontend, file)) }).toEqual({
        file,
        exists: false,
      });
    }
  });

  test('no source or config names className, NativeWind, Tailwind or base.css', async () => {
    const code = (await filesUnder(dir)).filter((file) => /\.(tsx?|jsx?|mjs|json)$/.test(file));
    // Vacuity floor: the screens, the data module, the configs and the manifests.
    expect(code.length).toBeGreaterThan(15);
    for (const file of code) {
      const content = await fs.readFile(path.join(dir, file), 'utf8');
      const found =
        /className|nativewind|tailwind|react-native-css|base\.css|global\.css|lightningcss/i.exec(
          content,
        );
      expect({ file, found: found?.[0] ?? null }).toEqual({ file, found: null });
    }
  });

  test('the frontend lists none of their packages, nor React Query', async () => {
    const pkg = await manifest('packages', 'frontend');
    const names = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)];
    expect(
      names.filter((name) =>
        /^(nativewind|tailwindcss|react-native-css|lightningcss|@tailwindcss\/.*|@tanstack\/.*)$/.test(
          name,
        ),
      ),
    ).toEqual([]);
  });
});

describe('the language set', () => {
  test('the frontend takes the language packages and the language Oxy set', async () => {
    const pkg = await manifest('packages', 'frontend');
    expect(pkg.dependencies['@oxy.so/bloom-language']).toBe(VERSIONS.oxyBloomLanguage);
    expect(pkg.dependencies['@oxy.so/bloom-data']).toBe(VERSIONS.oxyBloomData);
    expect(pkg.devDependencies['@oxy.so/bloom-language-compiler']).toBe(
      VERSIONS.oxyBloomLanguageCompiler,
    );
    expect(pkg.dependencies['@oxy.so/bloom']).toBe(LANGUAGE_OXY_VERSIONS.oxyBloom);
    expect(pkg.dependencies['@oxy.so/services']).toBe(LANGUAGE_OXY_VERSIONS.oxyServices);
    expect(pkg.dependencies['@oxy.so/core']).toBe(LANGUAGE_OXY_VERSIONS.oxyCore);
    expect(pkg.dependencies['@oxy.so/app-preset']).toBe(LANGUAGE_OXY_VERSIONS.oxyAppPreset);
  });

  test('the root forces the language Core and Bloom over the whole tree, backend included', async () => {
    const root = await manifest();
    for (const field of [root.overrides, root.resolutions]) {
      expect(field).toEqual({
        '@oxy.so/core': LANGUAGE_OXY_VERSIONS.oxyCore,
        '@oxy.so/bloom': LANGUAGE_OXY_VERSIONS.oxyBloom,
      });
    }
    const backend = await manifest('packages', 'backend');
    expect(backend.dependencies['@oxy.so/core']).toBe(LANGUAGE_OXY_VERSIONS.oxyCore);
    expect(root.scripts.test).toBe('bun run --cwd packages/frontend test');
  });

  test('it declares every native dependency the JSX frontend does, and the new required peers', async () => {
    const jsxTemplate = JSON.parse(
      await fs.readFile(
        path.join(
          __dirname,
          '..',
          '..',
          'templates',
          'jsx',
          'packages',
          'frontend',
          'package.json.tpl',
        ),
        'utf8',
      ),
    ) as Manifest;
    const pkg = await manifest('packages', 'frontend');
    const nativeWindOnly = /^(nativewind|tailwindcss|react-native-css|@tanstack\/.*)$/;
    const missing = Object.keys(jsxTemplate.dependencies)
      .filter((name) => !nativeWindOnly.test(name) && !name.endsWith('/shared-types'))
      .filter((name) => !(name in pkg.dependencies));
    expect(missing).toEqual([]);
    // Services 15's account store on a device, Bloom 23's required blur, the
    // language's glass on iOS and Bloom's swiped pager on Android.
    for (const name of [
      'expo-sqlite',
      'expo-blur',
      'expo-glass-effect',
      'react-native-pager-view',
    ]) {
      expect({ name, declared: name in pkg.dependencies }).toEqual({ name, declared: true });
    }
  });
});

describe('the compiler', () => {
  test('Metro is wrapped with the language compiler around the shared Oxy config', async () => {
    const metro = await read('metro.config.js');
    expect(metro).toContain("require('@oxy.so/bloom-language-compiler/metro')");
    expect(metro).toMatch(/withBloomLanguage\(\s*createOxyMetroConfig\(__dirname/);
    expect(await read('babel.config.js')).toContain("require('@oxy.so/app-preset/babel')");
    const tsconfig = JSON.parse(await read('tsconfig.json')) as { extends: string };
    expect(tsconfig.extends).toBe('@oxy.so/app-preset/tsconfig/frontend.json');
  });

  test('Jest runs Expo’s preset through the compiler’s transformer', async () => {
    const jest = await read('jest.config.js');
    expect(jest).toContain("preset: 'jest-expo'");
    expect(jest).toContain("'@oxy.so/bloom-language-compiler/jest'");
    const pkg = await manifest('packages', 'frontend');
    expect(pkg.scripts.test).toBe('jest');
    expect(pkg.scripts.typecheck).toBe('tsc --noEmit');
  });

  test('at least one test renders a screen', async () => {
    const tests = (await filesUnder(path.join(frontend, '__tests__'))).filter((file) =>
      file.endsWith('.test.tsx'),
    );
    expect(tests.length).toBeGreaterThan(0);
    const source = await read('__tests__', tests[0] as string);
    expect(source).toContain('renderRouter(');
    expect(source).toContain("from '../app/(app)/(tabs)/index'");
  });
});

describe('the routes', () => {
  test('every route file below the root is a layout() or a screen()', async () => {
    const routes = (await filesUnder(path.join(frontend, 'app'))).filter(
      (file) => file !== '_layout.tsx' && file !== '+html.tsx',
    );
    expect(routes.sort()).toEqual([
      '(app)/(tabs)/_layout.tsx',
      '(app)/(tabs)/index.tsx',
      '(app)/(tabs)/new.tsx',
      '(app)/_layout.tsx',
      '(app)/notes/[id].tsx',
      '(auth)/_layout.tsx',
      '(auth)/sign-in.tsx',
    ]);
    for (const route of routes) {
      const source = await read('app', route);
      const kind = path.basename(route) === '_layout.tsx' ? 'layout' : 'screen';
      expect({ route, exported: source.includes(`export default ${kind}(`) }).toEqual({
        route,
        exported: true,
      });
      expect(source).toContain("from '@oxy.so/bloom-language/router'");
    }
  });

  test('the app layout is a stack over the tabs, with the note pushed over them', async () => {
    const app = await read('app', '(app)', '_layout.tsx');
    expect(app).toContain("AppLayout(Stack('(tabs)', 'notes/[id]'))");
    expect(app).toContain('.destinations(');
    expect(await read('app', '(app)', '(tabs)', '_layout.tsx')).toContain(
      'layout(() => TabView())',
    );
  });

  test('the root keeps the provider stack, with one native stack: a Slot gate, no queryClient', async () => {
    const root = await read('app', '_layout.tsx');
    expect(root.match(/<BloomProvider\b/g)).toHaveLength(1);
    expect(root.match(/<OxyProvider\b/g)).toHaveLength(1);
    expect(root).toContain('scrollAdapter={expoRouterScrollAdapter}');
    expect(root).toContain('<AppImageResolver>');
    expect(root).toContain('<LocaleProvider>');
    expect(root).toContain('useHideNativeSplashWhenReady(isAuthResolved)');
    expect(root).toContain('<Slot />');
    expect(root).not.toMatch(/<Stack\b|queryClient|GestureHandlerRootView|SafeAreaProvider/);
  });
});

describe('the screens', () => {
  test('the list reads bloom-data, through a source over an entity and a list', async () => {
    const data = await read('lib', 'notes.ts');
    for (const part of ['entity<', 'list(', 'source(', 'action(']) expect(data).toContain(part);
    const list = await read('app', '(app)', '(tabs)', 'index.tsx');
    expect(list).toContain("from '@oxy.so/bloom-data'");
    expect(list).toContain('useList(notes)');
    expect(await read('components', 'note-row.ts')).toContain('useEntity(Note, id)');
  });

  test('the form binds its inputs and submits through an action', async () => {
    const form = await read('app', '(app)', '(tabs)', 'new.tsx');
    for (const input of ['TextField(title', 'TextEditor(body', 'Picker(', 'Toggle(pinned)']) {
      expect(form).toContain(input);
    }
    expect(form).toContain('useAction(addNote)');
    expect(form).toContain("Button(Text(t('form.save')))");
  });

  test('the header glass follows the Liquid Glass rules: one group, one tint, every icon labelled', async () => {
    const list = await read('app', '(app)', '(tabs)', 'index.tsx');
    expect(list.match(/GlassGroup\(/g)).toHaveLength(1);
    expect(list.match(/\.glass\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(list.match(/\.tint\(/g)).toHaveLength(1);
    const iconButtons = list.match(/Button\(Icon\(/g)?.length ?? 0;
    expect(list.match(/\.label\(/g)?.length).toBe(iconButtons);
  });
});

describe('the agent guide', () => {
  test('the frontend AGENTS.md points at the language cheat sheet and tour', async () => {
    const agents = await read('AGENTS.md');
    expect(agents).toContain('node_modules/@oxy.so/bloom/docs/bloom-language-for-agents.mdx');
    expect(agents).toContain('bloom-language-tour.mdx');
    expect(await read('CLAUDE.md')).toBe('@AGENTS.md\n');
    expect(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8')).toContain(
      'packages/frontend/AGENTS.md',
    );
  });
});
