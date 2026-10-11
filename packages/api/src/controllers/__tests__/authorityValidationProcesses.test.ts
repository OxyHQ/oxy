import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountMembers } from '../../db/schema/accountMembers';
import { users } from '../../db/schema/users';
import { insertBearerSession } from '../../routes/__fixtures__/bearerSessionFixtures';

jest.setTimeout(30_000);
let workers: ChildProcessWithoutNullStreams[] = [];
let sequence = 0;
async function worker() {
  const child = spawn(
    'bun',
    [resolve(__dirname, '../__fixtures__/authorityValidationWorker.mjs')],
    {
      env: { ...process.env, REDIS_URL: '', PG_MAX_POOL_SIZE: '2' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  workers.push(child);
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let readyResolve: () => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    readyResolve = resolveReady;
    readyReject = rejectReady;
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  lines.on('line', (line) => {
    if (!line.startsWith('RESULT:')) return;
    const message = JSON.parse(line.slice(7));
    if (message.ready) readyResolve();
    if (message.error) {
      const error = new Error(message.error);
      readyReject(error);
      waiting.forEach((pending) => pending.reject(error));
    }
    if (message.id) {
      waiting.get(message.id)?.resolve(message.result);
      waiting.delete(message.id);
    }
  });
  child.once('error', (error) => readyReject(error));
  child.once('exit', (code) => {
    const error = new Error(`Validation process exited ${code}: ${stderr}`);
    readyReject(error);
    waiting.forEach((pending) => pending.reject(error));
  });
  await ready;
  return async (action: string, data: Record<string, unknown>) => {
    const id = ++sequence;
    const answer = new Promise<unknown>((resolveAnswer, rejectAnswer) => {
      waiting.set(id, { resolve: resolveAnswer, reject: rejectAnswer });
    });
    child.stdin.write(`${JSON.stringify({ action, id, ...data })}\n`);
    return answer;
  };
}

beforeAll(async () => {
  await connectPostgres();
});
afterEach(() => {
  workers.forEach((child) => child.kill());
  workers = [];
});
afterAll(async () => {
  await closePostgres();
});

it.each(['validate', 'validate-header'])(
  '%s observes session revocation from another hot validation process',
  async (action) => {
    const [user] = await getDb()
      .insert(users)
      .values({ username: `u${randomUUID().slice(0, 10)}` })
      .returning();
    const sessionId = await insertBearerSession(user.id);
    const first = await worker();
    const second = await worker();
    expect(await first('warm', { sessionId })).toBe(true);
    expect(await second('warm', { sessionId })).toBe(true);
    await second('revoke', { sessionId });
    // No cache invalidation in the first process and no clock advance.
    expect(await first(action, { sessionId })).toEqual({ status: 401, valid: false });
  },
);

it('observes managed membership removal with both validation processes hot', async () => {
  const [operator] = await getDb().insert(users).values({}).returning();
  const [org] = await getDb().insert(users).values({ kind: 'organization' }).returning();
  await getDb()
    .insert(accountMembers)
    .values({ accountId: org.id, memberUserId: operator.id, role: 'admin', status: 'active' });
  const sessionId = await insertBearerSession(org.id, operator.id);
  const first = await worker();
  const second = await worker();
  expect(await first('warm', { sessionId })).toBe(true);
  expect(await second('warm', { sessionId })).toBe(true);
  await second('remove-member', { accountId: org.id, operatorId: operator.id });
  expect(await first('validate', { sessionId })).toEqual({ status: 401, valid: false });
  const [membership] = await getDb()
    .select()
    .from(accountMembers)
    .where(eq(accountMembers.accountId, org.id));
  expect(membership).toBeUndefined();
});
