import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRenderContext } from '../context';
import { renderTree } from '../render';

/**
 * A generated app must build natively, locally, on its first `expo prebuild` +
 * `./gradlew assembleRelease`. Oxy Move, the first app scaffolded from these
 * templates, could not, for three reasons this file pins:
 *
 *  - `expo-splash-screen` was configured with no image and the app shipped no
 *    icon, so `:app:processReleaseResources` failed on `drawable/splashscreen_logo`.
 *  - lightningcss was left to float to 1.32, which react-native-css 3.0.x cannot
 *    read ("failed to deserialize Specifier"), so the native Metro bundle failed.
 *  - the root `.gitignore` anchored `/android/` at the repo root, so the native
 *    project prebuild writes into `packages/frontend` was not ignored.
 *
 * These read the rendered template, not a real install: the scaffold-smoke
 * workflow is the gate that installs; these name the file in milliseconds.
 */

const TEMPLATES = path.join(import.meta.dir, '..', '..', 'templates');

const ctx = buildRenderContext({
  targetDir: '',
  name: 'My App',
  slug: 'my-app',
  scheme: 'myapp',
  bundleId: 'com.example.myapp',
  domain: 'api.example.com',
  backend: false,
  deploy: false,
  demo: false,
  install: false,
  git: false,
  register: false,
});

let dir: string;
let frontend: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oxy-scaffold-native-'));
  await renderTree(path.join(TEMPLATES, 'base'), dir, ctx);
  frontend = path.join(dir, 'packages', 'frontend');
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('the native splash and icons', () => {
  test('the splash is the shared Oxy splash, with an image, and its branding plugin follows it', async () => {
    const config = await fs.readFile(path.join(frontend, 'app.config.js'), 'utf8');

    expect(config).toContain("require('@oxy.so/expo-splash/config')");
    expect(config).toMatch(/oxySplashScreenPlugin\(\{\s*image:\s*'\.\/assets\/images\/splash-logo\.png'/);
    // The branding plugin augments the resources the splash tuple generates, so
    // it must come right after it.
    expect(config).toMatch(/oxySplashScreenPlugin\([^)]*\),\s*'@oxy\.so\/expo-splash',/);
    // The bare tuple is what shipped no `splashscreen_logo` drawable.
    expect(config).not.toContain("'expo-splash-screen'");
  });

  test('every asset app.config.js names is shipped', async () => {
    const config = await fs.readFile(path.join(frontend, 'app.config.js'), 'utf8');
    const assets = [...config.matchAll(/'(\.\/assets\/[^']+)'/g)].map((m) => m[1]);

    // Vacuity floor: icon, adaptive foreground/background/monochrome, favicon, splash.
    expect(new Set(assets).size).toBeGreaterThanOrEqual(6);
    for (const asset of assets) {
      expect({ asset, exists: existsSync(path.join(frontend, asset)) }).toEqual({ asset, exists: true });
    }
  });

  test('the frontend depends on @oxy.so/expo-splash, which the config and layout import', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(frontend, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies['@oxy.so/expo-splash']).toBeDefined();

    const layout = await fs.readFile(path.join(frontend, 'app', '_layout.tsx'), 'utf8');
    expect(layout).toContain('preventNativeSplashAutoHide();');
    expect(layout).toContain('useHideNativeSplashWhenReady(');
  });
});

describe('lightningcss', () => {
  test('the whole tree is forced onto the exact version react-native-css can read', async () => {
    const root = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as {
      overrides: Record<string, string>;
      resolutions: Record<string, string>;
    };
    for (const field of [root.overrides, root.resolutions]) {
      expect(field.lightningcss).toBe('1.30.1');
      expect(field['lightningcss-linux-x64-gnu']).toBe('1.30.1');
      expect(field['lightningcss-linux-x64-musl']).toBe('1.30.1');
    }
  });
});

describe('the prebuilt native projects', () => {
  test('are ignored where expo prebuild writes them', async () => {
    const run = async (cmd: string[]) => {
      const proc = Bun.spawn(cmd, { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return out;
    };
    await run(['git', 'init', '-q']);
    for (const native of ['android', 'ios']) {
      await fs.mkdir(path.join(frontend, native), { recursive: true });
      await fs.writeFile(path.join(frontend, native, 'build.gradle'), '');
    }
    const ignored = await run(['git', 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory']);
    expect(ignored.split('\n').filter(Boolean).sort()).toEqual([
      'packages/frontend/android/',
      'packages/frontend/ios/',
    ]);
  });
});
