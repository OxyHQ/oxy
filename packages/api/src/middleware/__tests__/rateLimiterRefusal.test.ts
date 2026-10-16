/**
 * Every limiter refuses the same way: 429, a `Retry-After` until the caller's
 * window resets, and the typed `RATE_LIMITED` error — the global budgets in
 * `security.ts` included. They used to answer their message as a bare text
 * body, so a machine caller (Kaana authorizing a grant) had no code to read.
 *
 * And the one way is built in one place: `middleware/rateLimiter.ts` is the
 * only source that imports `express-rate-limit`, and `RateLimitedError` is the
 * only 429 oxy-api builds — a service's budget (sign-in lockouts, the reauth
 * mail budget, Nominatim's refusal) throws it and `errorHandler` answers it
 * through `sendRateLimited`, with the same `Retry-After`.
 */

import express, { type RequestHandler } from 'express';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { asyncHandler } from '../../utils/asyncHandler';
import { RateLimitedError } from '../../utils/error';
import { errorHandler } from '../errorHandler';
import { rateLimit } from '../rateLimiter';
import { rateLimiter } from '../security';

interface Answer {
  status: number;
  retryAfter: string | undefined;
  body: unknown;
}

async function hit(limiter: RequestHandler, times: number): Promise<Answer> {
  const app = express();
  app.use(limiter);
  app.get('*', (_req, res) => res.json({ ok: true }));
  return request(app, times);
}

async function request(app: express.Express, times: number): Promise<Answer> {
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const { port } = server.address() as AddressInfo;
    let answer: Answer | undefined;
    for (let i = 0; i < times; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/anything`);
      answer = {
        status: res.status,
        retryAfter: res.headers.get('retry-after') ?? undefined,
        body: await res.json(),
      };
    }
    return answer as Answer;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('a limited request', () => {
  it('is answered with the typed error and when to retry', async () => {
    const limiter = rateLimit({
      prefix: 'test:typed:',
      windowMs: 60_000,
      max: 1,
      message: 'Slow down.',
    });

    const answer = await hit(limiter, 2);

    expect(answer.status).toBe(429);
    const retryAfter = Number(answer.retryAfter);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(answer.body).toEqual({
      error: 'RATE_LIMITED',
      message: 'Slow down.',
      details: { retryAfterSeconds: retryAfter },
    });
  });

  it('keeps the nested shape for the surfaces that use it, with the same wait', async () => {
    const limiter = rateLimit({
      prefix: 'test:nested:',
      windowMs: 60_000,
      max: 1,
      message: 'Slow down.',
      errorFormat: 'nested',
    });

    const answer = await hit(limiter, 2);

    expect(answer.status).toBe(429);
    expect(answer.body).toEqual({
      error: {
        code: 'rate_limited',
        message: 'Slow down.',
        details: { retryAfterSeconds: Number(answer.retryAfter) },
      },
    });
  });

  it("by a global budget is typed too, not the limiter's text", async () => {
    // Production ceiling under jest (NODE_ENV is not "development").
    const answer = await hit(rateLimiter, 1001);

    expect(answer.status).toBe(429);
    expect(answer.retryAfter).toBeDefined();
    expect(answer.body).toMatchObject({ error: 'RATE_LIMITED' });
  });
});

async function thrown(error: Error): Promise<Answer> {
  const app = express();
  app.get('*', () => {
    throw error;
  });
  app.use(errorHandler);
  return request(app, 1);
}

describe('a RateLimitedError a service throws', () => {
  it('is answered like a limiter refusal, its own contract code kept', async () => {
    const answer = await thrown(
      new RateLimitedError('Too many wrong attempts.', {
        code: 'SIGNIN_LOCKED',
        retryAfterSeconds: 4.2,
      }),
    );

    expect(answer).toEqual({
      status: 429,
      retryAfter: '5',
      body: {
        error: 'SIGNIN_LOCKED',
        message: 'Too many wrong attempts.',
        details: { retryAfterSeconds: 5 },
      },
    });
  });

  it('is answered the same from a route asyncHandler wraps', async () => {
    const app = express();
    app.get(
      '*',
      asyncHandler(async () => {
        throw new RateLimitedError('Too many codes.', { retryAfterSeconds: 90 });
      }),
    );

    expect(await request(app, 1)).toEqual({
      status: 429,
      retryAfter: '90',
      body: {
        error: 'RATE_LIMITED',
        message: 'Too many codes.',
        details: { retryAfterSeconds: 90 },
      },
    });
  });

  it('states no wait when none helps', async () => {
    const answer = await thrown(new RateLimitedError('Ask for a new code.'));

    expect(answer).toEqual({
      status: 429,
      retryAfter: undefined,
      body: { error: 'RATE_LIMITED', message: 'Ask for a new code.' },
    });
  });
});

describe('the limiters are built in one place', () => {
  const sourceRoot = path.resolve(__dirname, '../..');

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return entry === '__tests__' ? [] : sources(full);
      return full.endsWith('.ts') ? [full] : [];
    });
  }

  it('only middleware/rateLimiter.ts imports express-rate-limit', () => {
    const importers = sources(sourceRoot)
      .filter((file) => /from ['"]express-rate-limit['"]/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(sourceRoot, file));

    expect(importers).toEqual([path.join('middleware', 'rateLimiter.ts')]);
  });

  // The grant API and the inference edge answer their own public vocabularies,
  // whose status maps (`PUBLIC_ERROR_HTTP_STATUS`, `inferenceErrorStatus`) give
  // `rate_limited` its 429 and whose one sender each sets `Retry-After`.
  it('only RateLimitedError builds a 429', () => {
    const builders = sources(sourceRoot)
      .filter((file) =>
        /(?:status|sendStatus|ApiError|super)\(\s*429\b|statusCode\s*=\s*429\b/.test(
          readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => path.relative(sourceRoot, file));

    expect(builders).toEqual([path.join('utils', 'error.ts')]);
  });
});
