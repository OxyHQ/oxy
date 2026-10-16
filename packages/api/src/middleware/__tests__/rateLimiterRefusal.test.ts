/**
 * Every limiter refuses the same way: 429, a `Retry-After` until the caller's
 * window resets, and the typed `RATE_LIMITED` error — the global budgets in
 * `security.ts` included. They used to answer their message as a bare text
 * body, so a machine caller (Kaana authorizing a grant) had no code to read.
 *
 * And the one way is built in one place: `middleware/rateLimiter.ts` is the
 * only source that imports `express-rate-limit`.
 */

import express, { type RequestHandler } from 'express';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
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
});
