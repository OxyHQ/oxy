/** Run the real entrypoints in child processes with a real cache socket. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const source = resolve(__dirname, '../..');
const redisUrl = process.env.TEST_QUEUE_REDIS_URL ?? 'redis://127.0.0.1:6391';
let directory: string;
let preload: string;
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'video-repair-shutdown-'));
  preload = join(directory, 'preload.ts');
  writeFileSync(
    preload,
    `
import { mock } from 'bun:test';
import { getRedisClient } from ${JSON.stringify(join(source, 'config/redis.ts'))};
const mode = process.env.SHUTDOWN_TEST_MODE;
const event = name => console.log('SHUTDOWN_EVENT:' + name);
mock.module(${JSON.stringify(join(source, 'config/postgres.ts'))}, () => ({
  connectPostgres: async () => {},
  closePostgres: async () => {
    event('postgres');
    if (mode === 'close-error') throw new Error('fixture close failed');
  },
}));
mock.module(${JSON.stringify(join(source, 'services/cdnInvalidation.ts'))}, () => ({
  flushCdnInvalidations: async () => {
    await new Promise(resolve => setTimeout(resolve, 150));
    event('purge-flushed');
  },
}));
async function work() {
  const redis = getRedisClient();
  if (!redis) throw new Error('test must open a real cache socket');
  redis.on('end', () => event('redis-ended'));
  await redis.ping();
  event('work');
  if (mode === 'work-error') throw new Error('fixture work failed');
  return { failed: mode === 'partial' ? 1 : 0, unrecoverable: 0 };
}
mock.module(${JSON.stringify(join(source, 'scripts/video-rendition-repair.ts'))}, () => ({ repairVideoRenditions: work }));
mock.module(${JSON.stringify(join(source, 'scripts/video-rendition-backlog.ts'))}, () => ({ seedVideoRenditionBacklog: work }));
`,
  );
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it.each([
  ['repair-video-renditions.ts', 'success', 0],
  ['repair-video-renditions.ts', 'partial', 75],
  ['repair-video-renditions.ts', 'work-error', 1],
  ['repair-video-renditions.ts', 'close-error', 1],
  ['seed-video-rendition-backlog.ts', 'success', 0],
  ['seed-video-rendition-backlog.ts', 'work-error', 1],
  ['seed-video-rendition-backlog.ts', 'close-error', 1],
])('%s exits naturally after %s, preserving status %s', (script, mode, status) => {
  const result = spawnSync('bun', ['--preload', preload, join(source, 'scripts', script)], {
    env: { ...process.env, REDIS_URL: redisUrl, SHUTDOWN_TEST_MODE: mode, LOG_LEVEL: 'fatal' },
    encoding: 'utf8',
    timeout: 5000,
  });
  expect({ error: result.error?.message, stderr: result.stderr }).toEqual({
    error: undefined,
    stderr: '',
  });
  expect(result.status).toBe(status);
  const events = result.stdout.split('\n').filter((line) => line.startsWith('SHUTDOWN_EVENT:'));
  expect(events).toEqual(
    script.startsWith('repair')
      ? [
          'SHUTDOWN_EVENT:work',
          'SHUTDOWN_EVENT:purge-flushed',
          'SHUTDOWN_EVENT:postgres',
          'SHUTDOWN_EVENT:redis-ended',
        ]
      : ['SHUTDOWN_EVENT:work', 'SHUTDOWN_EVENT:postgres', 'SHUTDOWN_EVENT:redis-ended'],
  );
});
