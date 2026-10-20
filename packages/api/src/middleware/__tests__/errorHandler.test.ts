import express from 'express';
import request from 'supertest';
import { errorHandler } from '../errorHandler';
import { ApiError, BadRequestError, InternalServerError } from '../../utils/error';
import { logger } from '../../utils/logger';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

beforeEach(() => jest.clearAllMocks());

function createMockRes() {
  const res: any = { headersSent: false };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('errorHandler middleware', () => {
  const req = {} as any;
  const next = jest.fn();

  it('formats ApiError using toJSON()', () => {
    const res = createMockRes();
    const error = new BadRequestError('Invalid input', { field: 'email' });

    errorHandler(error, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'BAD_REQUEST',
      message: 'Invalid input',
      details: { field: 'email' },
    });
  });

  it('uses correct status code for different ApiError subclasses', () => {
    const res = createMockRes();
    const error = new InternalServerError('Something broke');

    errorHandler(error, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Something broke',
    });
  });

  it('wraps unknown Error in InternalServerError (non-production)', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    const res = createMockRes();
    const error = new Error('unexpected crash');

    errorHandler(error, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'unexpected crash',
    });

    process.env.NODE_ENV = originalEnv;
  });

  it('hides error details in production', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const res = createMockRes();
    const error = new Error('secret internal detail');

    errorHandler(error, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    });

    process.env.NODE_ENV = originalEnv;
  });

  it('logs a 4xx ApiError at warn and a 5xx at error', () => {
    errorHandler(new BadRequestError('Invalid input'), req, createMockRes(), next);
    expect(logger.warn).toHaveBeenCalledWith('ApiError [400] BAD_REQUEST: Invalid input');
    expect(logger.error).not.toHaveBeenCalled();

    errorHandler(new InternalServerError('Something broke'), req, createMockRes(), next);
    expect(logger.error).toHaveBeenCalledWith(
      'ApiError [500] INTERNAL_SERVER_ERROR: Something broke',
    );
  });

  it("answers body-parser's request.aborted 400 without an error log", () => {
    // The shape body-parser's http-errors give a body the client hung up on.
    const aborted = Object.assign(new Error('request aborted'), {
      status: 400,
      statusCode: 400,
      expose: true,
      type: 'request.aborted',
    });
    const res = createMockRes();

    errorHandler(aborted, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'BAD_REQUEST', message: 'request aborted' });
    expect(logger.debug).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('hides the message of a client error that is not marked expose', () => {
    const res = createMockRes();
    const error = Object.assign(new Error('internal parser detail'), {
      status: 400,
      expose: false,
    });

    errorHandler(error, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'BAD_REQUEST', message: 'Bad Request' });
  });

  it("keeps an upstream client's 4xx a 500: only http-errors and URIError are the caller's", () => {
    const res = createMockRes();
    // An AxiosError carries the UPSTREAM response's status.
    const upstream = Object.assign(new Error('Request failed with status code 401'), {
      status: 401,
    });

    errorHandler(upstream, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(logger.error).toHaveBeenCalled();
  });

  it('hands a client error to Express once the response has started', () => {
    const res = createMockRes();
    res.headersSent = true;
    const error = Object.assign(new Error('request aborted'), {
      status: 400,
      expose: true,
      type: 'request.aborted',
    });

    errorHandler(error, req, res, next);

    expect(next).toHaveBeenCalledWith(error);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('handles non-Error thrown values', () => {
    const res = createMockRes();

    errorHandler('string error', req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'INTERNAL_SERVER_ERROR',
      }),
    );
  });
});

describe('errorHandler with the errors Express itself raises', () => {
  const app = express();
  app.post('/echo', express.json({ limit: '16b' }), (req, res) => {
    res.json({ data: req.body });
  });
  app.get('/items/:id', (req, res) => {
    res.json({ data: req.params.id });
  });
  app.use(errorHandler);

  it('answers an undecodable path parameter 400 in the ApiError shape', async () => {
    const res = await request(app).get('/items/%c0');

    expect(res.status).toBe(400);
    // Express's URIError is not marked expose, so its message stays inside.
    expect(res.body).toEqual({ error: 'BAD_REQUEST', message: 'Bad Request' });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('answers a body over the limit 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await request(app)
      .post('/echo')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ text: 'x'.repeat(64) }));

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'PAYLOAD_TOO_LARGE', message: 'request entity too large' });
    expect(logger.warn).toHaveBeenCalledWith(
      'Client error',
      expect.objectContaining({ status: 413, type: 'entity.too.large' }),
    );
  });

  it('answers malformed JSON 400, not 500', async () => {
    const res = await request(app)
      .post('/echo')
      .set('content-type', 'application/json')
      .send('{"a":');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('BAD_REQUEST');
    expect(logger.error).not.toHaveBeenCalled();
  });
});
