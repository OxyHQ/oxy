import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), '../src/emulator-preflight.mjs');
const header = 'List of devices attached\n';
const node = Bun.which('node');
if (!node) throw new Error('Node is required to test the published CLI');

async function run(args, { devices = header, reply = 'test_avd\nOK\n', fail = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'oxy-emulator-preflight-'));
  const log = join(dir, 'adb.log');
  try {
    const fakeAdb = join(dir, 'adb');
    await writeFile(
      fakeAdb,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$OXY_TEST_ADB_LOG"
if [ "$OXY_TEST_FAIL" = yes ]; then exit 1; fi
if [ "$1" = devices ]; then printf '%s' "$OXY_TEST_DEVICES"; else printf '%s' "$OXY_TEST_REPLY"; fi
`,
    );
    await chmod(fakeAdb, 0o755);
    const result = spawnSync(node, [cli, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: dir,
        OXY_TEST_ADB_LOG: log,
        OXY_TEST_DEVICES: devices,
        OXY_TEST_REPLY: reply,
        OXY_TEST_FAIL: fail ? 'yes' : 'no',
      },
    });
    const calls = await readFile(log, 'utf8').catch(() => '');
    return { result, calls: calls.trim().split('\n').filter(Boolean) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('emulator preflight', () => {
  test('requires an explicit emulator serial before invoking adb', async () => {
    for (const args of [[], ['--serial', 'physical-123'], ['--serial', 'emulator-5554', 'extra']]) {
      const { result, calls } = await run(args);
      expect(result.status).toBe(1);
      expect(calls).toEqual([]);
    }
  });

  test('accepts the explicitly selected emulator when other devices are present', async () => {
    const { result, calls } = await run(['--serial', 'emulator-5554'], {
      devices: `${header}phone-123 device product:phone\nemulator-5554 device product:sdk\nemulator-5556 device\n`,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('emulator-5554\n');
    expect(calls).toEqual(['devices -l', '-s emulator-5554 emu avd name']);
  });

  test('never queries a target when it is absent, offline, or ambiguous', async () => {
    for (const devices of [
      header,
      `${header}phone-123 device\n`,
      `${header}emulator-5554 offline\n`,
      `${header}emulator-5554 unauthorized\n`,
      `${header}emulator-5554 device\nemulator-5554 device\n`,
      'unexpected output\nemulator-5554 device\n',
    ]) {
      const { result, calls } = await run(['--serial', 'emulator-5554'], { devices });
      expect(result.status).toBe(1);
      expect(calls).toEqual(['devices -l']);
    }
  });

  test('rejects adb failures and devices that cannot report an AVD', async () => {
    const failing = await run(['--serial', 'emulator-5554'], { fail: true });
    expect(failing.result.status).toBe(1);
    expect(failing.calls).toEqual(['devices -l']);
    for (const reply of ['', 'KO\n', 'unknown\n', 'test_avd\nKO\n']) {
      const { result, calls } = await run(['--serial', 'emulator-5554'], {
        devices: `${header}emulator-5554 device\n`,
        reply,
      });
      expect(result.status).toBe(1);
      expect(calls).toEqual(['devices -l', '-s emulator-5554 emu avd name']);
    }
  });
});
