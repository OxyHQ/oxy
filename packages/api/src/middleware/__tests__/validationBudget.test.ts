import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { validate } from '../validate';
import { errorHandler } from '../errorHandler';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

it('rejects an oversized bounded collection before evaluating its elements', async () => {
  const element = jest.fn((value: unknown) => value);
  const accepted = jest.fn();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.post(
    '/batch',
    validate({ body: z.object({ ids: z.array(z.preprocess(element, z.string())).max(100) }) }),
    (_req, res) => {
      accepted();
      res.sendStatus(204);
    },
  );
  app.use(errorHandler);
  // 20 KiB fits the existing ingress limit. Zod 3 constructed 10,001 issues
  // here despite max(100), so a body-byte limit alone never fixed the advisory.
  const response = await request(app)
    .post('/batch')
    .send({ ids: Array(10_000).fill(0) });
  expect(response.status).toBe(400);
  expect(response.body).toMatchObject({ error: 'BAD_REQUEST', message: 'Validation failed' });
  expect(response.body.details.issues).toEqual([
    { path: 'ids', code: 'too_big', message: expect.any(String) },
  ]);
  expect(element).not.toHaveBeenCalled();
  expect(accepted).not.toHaveBeenCalled();

  const valid = await request(app)
    .post('/batch')
    .send({ ids: ['one', 'two'] });
  expect(valid.status).toBe(204);
  expect(element).toHaveBeenCalledTimes(2);
  expect(accepted).toHaveBeenCalledTimes(1);
});
