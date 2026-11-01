const mockPrefixes: string[] = [];
const mockGetRedisClient = jest.fn(() => ({ status: 'ready' }));
jest.mock('../../config/redis', () => ({ getRedisClient: mockGetRedisClient }));
jest.mock('../rateLimiter', () => ({
  rateLimit: ({ prefix }: { prefix: string }) => {
    mockPrefixes.push(prefix);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
jest.mock('../../utils/ipKey', () => ({ hashedIpKey: () => 'synthetic-ip' }));

const originalEnv = process.env;
beforeEach(() => {
  jest.resetModules();
  mockPrefixes.length = 0;
  mockGetRedisClient.mockClear();
  process.env = { ...originalEnv, REDIS_URL: 'redis://synthetic.invalid' };
  delete process.env.OXY_HOLDER_EVIDENCE_ENABLED;
  delete process.env.OXY_HOLDER_EVIDENCE_SUBJECT_PER_MINUTE;
  delete process.env.OXY_HOLDER_EVIDENCE_IP_PER_MINUTE;
  delete process.env.OXY_HOLDER_EVIDENCE_GLOBAL_PER_MINUTE;
});
afterAll(() => {
  process.env = originalEnv;
});

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

it.each(['disabled', 'missing-budget', 'over-maximum', 'missing-redis'])(
  'fails closed without allocating holder limiters when %s',
  async (scenario) => {
    if (scenario !== 'disabled') {
      process.env.OXY_HOLDER_EVIDENCE_ENABLED = 'true';
      process.env.OXY_HOLDER_EVIDENCE_SUBJECT_PER_MINUTE = '10';
      process.env.OXY_HOLDER_EVIDENCE_IP_PER_MINUTE = '20';
      process.env.OXY_HOLDER_EVIDENCE_GLOBAL_PER_MINUTE = '30';
    }
    if (scenario === 'missing-budget') delete process.env.OXY_HOLDER_EVIDENCE_GLOBAL_PER_MINUTE;
    if (scenario === 'over-maximum') process.env.OXY_HOLDER_EVIDENCE_SUBJECT_PER_MINUTE = '61';
    if (scenario === 'missing-redis') delete process.env.REDIS_URL;
    const { holderContextEvidenceBudget } = await import('../security');
    const res = response();
    const next = jest.fn();
    holderContextEvidenceBudget({} as never, res as never, next);
    expect(res.result.statusCode).toBe(503);
    expect(res.result.body).toEqual({ error: 'evidence_unavailable' });
    expect(res.result.headers['cache-control']).toBe('no-store');
    expect(next).not.toHaveBeenCalled();
    expect(mockGetRedisClient).not.toHaveBeenCalled();
    expect(
      mockPrefixes.filter((prefix) => prefix.startsWith('rl:session:holder-evidence:')),
    ).toEqual([]);
  },
);
