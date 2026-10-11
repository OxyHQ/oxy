import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { readPrivateFile, reservePrivateFile, writePrivateJson } from '../privateOperatorFiles';
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'oxy-operator-'));
  chmodSync(directory, 0o700);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
it('reserves private material durably and refuses overwrite on response-loss reconciliation', () => {
  const file = join(directory, 'material.json');
  const fd = reservePrivateFile(file);
  try {
    writePrivateJson(fd, { secret: 'synthetic-private-material' });
  } finally {
    closeSync(fd);
  }
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readPrivateFile(file).toString())).toEqual({
    secret: 'synthetic-private-material',
  });
  expect(() => reservePrivateFile(file)).toThrow();
  expect(readFileSync(file, 'utf8')).toContain('synthetic-private-material');
});
it('rejects publicly accessible directories/files and symlinks', () => {
  const file = join(directory, 'material.json');
  chmodSync(directory, 0o755);
  expect(() => reservePrivateFile(file)).toThrow();
  chmodSync(directory, 0o700);
  const fd = reservePrivateFile(file);
  closeSync(fd);
  chmodSync(file, 0o644);
  expect(() => readPrivateFile(file)).toThrow();
  chmodSync(file, 0o600);
  const link = join(directory, 'alias');
  symlinkSync(file, link);
  expect(() => readPrivateFile(link)).toThrow();
  expect(() => reservePrivateFile(link)).toThrow();
});
it('a colliding result cannot replace the original receipt or pending evidence', () => {
  const pending = join(directory, 'attempt');
  const result = `${pending}.result.json`;
  const old = reservePrivateFile(result);
  try {
    writePrivateJson(old, { existing: true });
  } finally {
    closeSync(old);
  }
  const fd = reservePrivateFile(pending);
  try {
    expect(() => reservePrivateFile(result)).toThrow();
  } finally {
    closeSync(fd);
  }
  expect(JSON.parse(readPrivateFile(result).toString())).toEqual({
    existing: true,
  });
  expect(statSync(pending).mode & 0o777).toBe(0o600);
});

it('local material mode authenticates the synthetic operator and never opens the deliberately unavailable DB', () => {
  const bin = join(directory, 'bin');
  mkdirSync(bin, { mode: 0o700 });
  const arn = 'arn:aws:iam::237343248947:user/synthetic-fixture';
  writeFileSync(
    join(bin, 'aws'),
    `#!/bin/sh\nprintf '%s' '{"Account":"237343248947","Arn":"${arn}","UserId":"synthetic"}'\n`,
    { mode: 0o700 },
  );
  const material = join(directory, 'material.json');
  const output = join(directory, 'attempt');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    DATABASE_URL: 'postgres://unavailable.invalid/synthetic',
    EXPECTED_OPERATOR_ARN: arn,
    EPHEMERAL_OUTPUT: output,
    EPHEMERAL_MATERIAL: material,
  };
  const args = [
    '--no-env-file',
    resolve(__dirname, '../../../scripts/mercaria-ephemeral-credential.ts'),
    'material',
  ];
  const first = spawnSync('bun', args, {
    env,
    encoding: 'utf8',
    timeout: 15000,
  });
  expect(first.status).toBe(0);
  expect(first.stdout.trim()).toBe('MERCARIA_EPHEMERAL_OK material');
  const stored = JSON.parse(readPrivateFile(material).toString());
  expect(stored.publicKey).toMatch(/^oxy_dk_[a-f0-9]{48}$/);
  expect(first.stdout + first.stderr).not.toContain(stored.secret);
  expect(first.stdout + first.stderr).not.toContain('unavailable.invalid');
  const second = spawnSync('bun', args, {
    env,
    encoding: 'utf8',
    timeout: 15000,
  });
  expect(second.status).toBe(1);
  expect(JSON.parse(readPrivateFile(material).toString())).toEqual(stored);
  expect(second.stderr).toContain('no automatic retry');
});
