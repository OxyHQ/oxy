/** Owned Redis + actual HTTP/RedisStore limiter rehearsal, not a provider/mint test. */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import ts from 'typescript';
import { closeRedis, getRedisClient } from '../../packages/api/src/config/redis';
import { rateLimit } from '../../packages/api/src/middleware/rateLimiter';
import { serviceTokenMintRateLimitKey } from '../../packages/api/src/utils/serviceRateLimitKey';

const requireApi = createRequire(new URL('../../packages/api/package.json', import.meta.url));
const express = requireApi('express') as typeof import('express');
const expectedPid = Number(process.env.OXY_CAPACITY_OWNED_REDIS_PID);
if (
  !Number.isSafeInteger(expectedPid) ||
  expectedPid <= 0 ||
  process.env.REDIS_URL !== 'redis://127.0.0.1:6389/0'
)
  throw new Error('Owned launcher required');
const redis = (() => {
  const client = getRedisClient();
  if (!client) throw new Error('Redis required: no MemoryStore capacity claim');
  return client;
})();
const original = readFileSync(
  new URL('../../packages/api/src/routes/auth.ts', import.meta.url),
  'utf8',
);
const source = ts.createSourceFile('auth.ts', original, ts.ScriptTarget.Latest, true);
const names = ['serviceTokenLimiter', 'serviceTokenAddressLimiter', 'workloadTokenLimiter'];
type Options = Parameters<typeof rateLimit>[0];
const configurations = new Map<string, Options>();
// Compile the exact checked-in declarations, rather than reproducing their constants.
// Only the reviewed local source is evaluated. No supplied file/path/code is accepted.
for (const name of names) {
  const matches = source.statements.filter(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) => declaration.name.getText(source) === name,
      ),
  );
  if (matches.length !== 1) throw new Error(`Expected one source declaration: ${name}`);
  const javascript = ts.transpileModule(matches[0].getText(source), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText;
  const capture = (options: Options) => {
    configurations.set(name, options);
    return null;
  };
  new Function('rateLimit', 'serviceTokenMintRateLimitKey', `${javascript}\nreturn ${name};`)(
    capture,
    serviceTokenMintRateLimitKey,
  );
}
function configuration(name: string): Options {
  const value = configurations.get(name);
  if (!value) throw new Error(`Missing declaration ${name}`);
  return value;
}
function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}
const servers: http.Server[] = [];
async function ownedRedis() {
  const info = await redis.info('server');
  check(new RegExp(`^process_id:${expectedPid}\\r?$`, 'm').test(info), 'Owned Redis PID mismatch');
}
async function reset() {
  await ownedRedis();
  await redis.flushdb(); // Only the fresh launcher-owned Redis, never a configured/shared store.
}
async function request(
  server: http.Server,
  path: string,
  apiKey = 'capacity-public-key',
): Promise<number> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error('HTTP probe timeout')));
    req.on('error', reject);
    req.end(JSON.stringify({ apiKey })); // Public fixture handle; no secret/token or financial operation.
  });
}
async function burst(count: number, path: string, apiKey?: string) {
  const statuses: number[] = [];
  for (let offset = 0; offset < count; offset += 40) {
    statuses.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(40, count - offset) }, (_, index) =>
          request(servers[(offset + index) % 2], path, apiKey),
        ),
      )),
    );
  }
  return {
    success: statuses.filter((value) => value === 200).length,
    throttled: statuses.filter((value) => value === 429).length,
    unexpected: statuses.filter((value) => value !== 200 && value !== 429),
  };
}
const results: Record<string, unknown> = {};
try {
  await ownedRedis();
  for (const name of names) {
    const value = configuration(name);
    check(
      value.windowMs === 300000 && value.max === (name === 'serviceTokenLimiter' ? 30 : 600),
      `${name} production ceiling changed`,
    );
  }
  // Each API instance creates its own RedisStore. Prefixes are the real route prefixes.
  for (let index = 0; index < 2; index++) {
    const app = express();
    app.use(express.json());
    app.post('/credential', rateLimit(configuration('serviceTokenLimiter')), (_req, res) =>
      res.sendStatus(200),
    );
    app.post('/address', rateLimit(configuration('serviceTokenAddressLimiter')), (_req, res) =>
      res.sendStatus(200),
    );
    app.post('/workload', rateLimit(configuration('workloadTokenLimiter')), (_req, res) =>
      res.sendStatus(200),
    );
    servers.push(
      await new Promise<http.Server>((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
      }),
    );
  }
  await reset();
  results.credentialMeasuredCohortModel = await burst(18, '/credential'); // 6 caches × 2 renewals + 6 readiness, conditional cache count.
  check(
    JSON.stringify(results.credentialMeasuredCohortModel) ===
      JSON.stringify({ success: 18, throttled: 0, unexpected: [] }),
    'Cohort model rejected',
  );
  await reset();
  results.credentialBoundary15Caches = await burst(30, '/credential');
  check(
    JSON.stringify(results.credentialBoundary15Caches) ===
      JSON.stringify({ success: 30, throttled: 0, unexpected: [] }),
    '30 boundary rejected',
  );
  const ttl = await redis.pttl('rl:auth:service-token:key:capacity-public-key');
  check(ttl > 250000 && ttl <= 300000, 'Redis five-minute window absent');
  results.credentialRedisTtlMs = ttl;
  await reset();
  results.credentialNegative16Caches = await burst(32, '/credential');
  check(
    JSON.stringify(results.credentialNegative16Caches) ===
      JSON.stringify({ success: 30, throttled: 2, unexpected: [] }),
    'Shared credential should reject 16 × 2 bursts',
  );
  check(
    (await request(servers[1], '/credential', 'independent-public-key')) === 200,
    'Independent credential shares budget',
  );
  await reset();
  results.workload81SlotsThreeMints = await burst(81 * 3 * 2, '/workload');
  check(
    JSON.stringify(results.workload81SlotsThreeMints) ===
      JSON.stringify({ success: 486, throttled: 0, unexpected: [] }),
    'Conditional workload model rejected',
  );
  results.workloadRemaining = await burst(114, '/workload');
  check(
    JSON.stringify(results.workloadRemaining) ===
      JSON.stringify({ success: 114, throttled: 0, unexpected: [] }),
    'Workload boundary incorrect',
  );
  check((await request(servers[0], '/workload')) === 429, 'Workload 601 must fail');
  // The key-pair NAT budget has its own prefix and is not consumed by workload traffic.
  results.address600 = await burst(600, '/address');
  check(
    JSON.stringify(results.address600) ===
      JSON.stringify({ success: 600, throttled: 0, unexpected: [] }),
    'Address prefix/boundary incorrect',
  );
  check((await request(servers[1], '/address')) === 429, 'Address 601 must fail');
  // Artificial expiry tests recovery without claiming a natural five-minute elapsed measurement.
  const workloadKeys = await redis.keys('rl:auth:service-token-workload:*');
  check(workloadKeys.length === 1, 'Unexpected own workload counter');
  await redis.pexpire(workloadKeys[0], 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  check((await request(servers[0], '/workload')) === 200, 'Expired shared counter did not recover');
  console.log(
    JSON.stringify(
      {
        redisPid: expectedPid,
        actualRedisStores: 6,
        apiInstances: 2,
        actualRouteDeclarations: names,
        results,
        limits: [
          'HTTP probes simulate successful mint traffic only',
          'Burst/window arithmetic; no elapsed-240-second or production mint observation',
          '81 rolling slots are not an attestation of 81 client caches',
          'No issuer, provider, credentials or effects invoked',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  await closeRedis();
}
