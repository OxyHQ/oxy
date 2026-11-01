import jwt from 'jsonwebtoken';

jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));

const mockRedis = { status: 'ready' };
const mockCalls: string[] = [];
let mockFailPrefix: string | null = null;
jest.mock('../../config/redis', () => ({ getRedisClient: () => mockRedis }));
jest.mock('../rateLimiter', () => ({
  rateLimit:
    ({ prefix }: { prefix: string }) =>
    (_req: unknown, _res: unknown, next: (error?: Error) => void) => {
      mockCalls.push(prefix);
      next(prefix === mockFailPrefix ? new Error('synthetic failure') : undefined);
    },
}));
jest.mock('../../utils/ipKey', () => ({ hashedIpKey: () => 'synthetic-ip' }));

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.REDIS_URL = 'redis://synthetic.invalid';
  process.env.ACCESS_TOKEN_SECRET = 'synthetic-budget-test-key';
  process.env.OXY_HOLDER_EVIDENCE_ENABLED = 'true';
  process.env.OXY_HOLDER_EVIDENCE_SUBJECT_PER_MINUTE = '10';
  process.env.OXY_HOLDER_EVIDENCE_IP_PER_MINUTE = '20';
  process.env.OXY_HOLDER_EVIDENCE_GLOBAL_PER_MINUTE = '30';
  process.env.OXY_LIVE_SESSION_ENABLED = 'true';
  process.env.OXY_LIVE_SESSION_SUBJECT_PER_MINUTE = '10';
  process.env.OXY_LIVE_SESSION_IP_PER_MINUTE = '20';
  process.env.OXY_LIVE_SESSION_GLOBAL_PER_MINUTE = '30';
});

beforeEach(() => {
  mockRedis.status = 'ready';
  mockCalls.length = 0;
  mockFailPrefix = null;
});

function request(authorization?: string, live = false) {
  return {
    headers: { authorization },
    header(name: string) {
      return name.toLowerCase() === 'x-oxy-session-authority' && live ? 'live-v1' : undefined;
    },
  };
}

function response() {
  const result = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
  };
  return {
    result,
    setHeader(name: string, value: string) {
      result.headers[name.toLowerCase()] = value;
    },
    vary() {},
    status(code: number) {
      result.statusCode = code;
      return this;
    },
    json(body: unknown) {
      result.body = body;
      return this;
    },
  };
}

function signedBearer(secret = 'synthetic-budget-test-key') {
  return `Bearer ${jwt.sign({ userId: 'user', sessionId: 'session' }, secret, { expiresIn: '1m' })}`;
}

it('bounds verified requests by distinct subject, address and global holder budgets', async () => {
  const { holderContextEvidenceBudget } = await import('../security');
  const res = response();
  const next = jest.fn();
  holderContextEvidenceBudget(request(signedBearer()) as never, res as never, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(res.result.headers['cache-control']).toBe('no-store');
  expect(mockCalls).toEqual([
    'rl:session:holder-evidence:subject:',
    'rl:session:holder-evidence:ip:',
    'rl:session:holder-evidence:global:',
  ]);
});

it.each([undefined, 'Bearer malformed', signedBearer('wrong-key')])(
  'rejects missing or forged bearer before the global budget',
  async (authorization) => {
    const { holderContextEvidenceBudget } = await import('../security');
    const res = response();
    const next = jest.fn();
    holderContextEvidenceBudget(request(authorization) as never, res as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.result.statusCode).toBe(401);
    expect(res.result.body).toEqual({ error: 'invalid_bearer' });
    expect(mockCalls).not.toContain('rl:session:holder-evidence:global:');
  },
);

it.each([
  'rl:session:holder-evidence:subject:',
  'rl:session:holder-evidence:ip:',
  'rl:session:holder-evidence:global:',
])('fails closed when %s is unavailable', async (prefix) => {
  mockFailPrefix = prefix;
  const { holderContextEvidenceBudget } = await import('../security');
  const res = response();
  const next = jest.fn();
  holderContextEvidenceBudget(request(signedBearer()) as never, res as never, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.result.statusCode).toBe(503);
  expect(res.result.body).toEqual({ error: 'evidence_unavailable' });
});

it('returns 503 while Redis is unavailable', async () => {
  mockRedis.status = 'end';
  const { holderContextEvidenceBudget } = await import('../security');
  const res = response();
  const next = jest.fn();
  holderContextEvidenceBudget(request(signedBearer()) as never, res as never, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.result.statusCode).toBe(503);
  expect(res.result.body).toEqual({ error: 'evidence_unavailable' });
  expect(mockCalls).toEqual([]);
});

it('keeps the pre-existing live-validation budget and refusal shape', async () => {
  const { sessionHeaderValidationBudget } = await import('../security');
  const res = response();
  const next = jest.fn();
  sessionHeaderValidationBudget(request('Bearer malformed', true) as never, res as never, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.result.statusCode).toBe(401);
  expect(res.result.body).toEqual({ message: 'Bearer cannot be verified' });
  expect(mockCalls).toEqual(['rl:session:live:subject:', 'rl:session:live:ip:']);
});
