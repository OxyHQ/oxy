import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/expo-android.mjs', import.meta.url));
const classifier = 'so.oxy.devicesession.OxyDeviceSessionModule';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'oxy-expo-check-'));
  const services = join(root, 'node_modules/@oxy.so/services');
  const autolinking = join(root, 'node_modules/expo-modules-autolinking');
  const native = join(services, 'android');
  const sources = join(native, 'src/main/java/so/oxy/devicesession');
  await mkdir(sources, { recursive: true });
  await mkdir(join(autolinking, 'bin'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{}');
  await writeFile(
    join(services, 'package.json'),
    JSON.stringify({ name: '@oxy.so/services', version: '13.15.5' }),
  );
  await writeFile(join(autolinking, 'package.json'), '{}');
  await writeFile(join(sources, 'OxyDeviceSessionModule.kt'), '');
  await writeFile(join(sources, 'SharedDeviceSessionPublish.kt'), '');
  const result = {
    modules: [
      {
        packageName: '@oxy.so/services',
        packageVersion: '13.15.5',
        projects: [{ sourceDir: native, modules: [{ classifier }] }],
      },
    ],
  };
  const expectedArgs = ['resolve', '--platform', 'android', '--project-root', root, '--json'];
  const writeResult = async (value) =>
    writeFile(
      join(autolinking, 'bin/expo-modules-autolinking.js'),
      `if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(expectedArgs))}) process.exit(2); process.stdout.write(${JSON.stringify(value)});`,
    );
  await writeResult(JSON.stringify(result));
  const run = (...args) =>
    spawnSync('node', [cli, `--project-root=${root}`, ...args], { encoding: 'utf8' });
  return { root, sources, result, writeResult, run };
}

async function withFixture(fn) {
  const f = await fixture();
  try {
    await fn(f);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}

describe('Expo Android autolinking check', () => {
  test('runs the installed resolver and checks its selected package and required sources', async () =>
    withFixture(async (f) => {
      const run = f.run('--require-source=SharedDeviceSessionPublish.kt');
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('Oxy Services 13.15.5');
      expect(run.stderr).toBe('');
      await rm(join(f.sources, 'SharedDeviceSessionPublish.kt'));
      expect(f.run('--require-source=SharedDeviceSessionPublish.kt').status).toBe(1);
      expect(f.run().status).toBe(0);
    }));
  test('rejects absent, duplicate, mismatched, and malformed package results', async () =>
    withFixture(async (f) => {
      const entry = f.result.modules[0];
      for (const value of [
        { modules: [] },
        { modules: [entry, entry] },
        { modules: [{ ...entry, packageVersion: '13.15.3' }] },
        { modules: [{ ...entry, projects: [] }] },
        {},
      ]) {
        await f.writeResult(JSON.stringify(value));
        expect(f.run().status).toBe(1);
      }
      await f.writeResult('sentinel-secret, not json');
      const malformed = f.run();
      expect(malformed.status).toBe(1);
      expect(malformed.stderr).not.toContain('sentinel-secret');
    }));
  test('rejects a wrong source directory and duplicate module projects', async () =>
    withFixture(async (f) => {
      const entry = f.result.modules[0];
      const project = entry.projects[0];
      await f.writeResult(
        JSON.stringify({ modules: [{ ...entry, projects: [{ ...project, sourceDir: f.root }] }] }),
      );
      expect(f.run().status).toBe(1);
      await f.writeResult(
        JSON.stringify({ modules: [{ ...entry, projects: [project, project] }] }),
      );
      expect(f.run().status).toBe(1);
      await f.writeResult(
        JSON.stringify({
          modules: [
            { ...entry, projects: [{ ...project, modules: [{ classifier }, { classifier }] }] },
          ],
        }),
      );
      expect(f.run().status).toBe(1);
      await rm(join(f.sources, 'OxyDeviceSessionModule.kt'));
      await f.writeResult(JSON.stringify(f.result));
      expect(f.run().status).toBe(1);
    }));
  test('fails on resolver errors and invalid arguments without revealing resolver output', async () =>
    withFixture(async (f) => {
      await writeFile(
        join(f.root, 'node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js'),
        "console.error('sentinel-secret'); process.exit(1)",
      );
      const failure = f.run();
      expect(failure.status).toBe(1);
      expect(failure.stderr).not.toContain('sentinel-secret');
      expect(f.run('--require-source=../../secret.kt').status).toBe(1);
      expect(f.run('--unknown').status).toBe(1);
    }));
});
