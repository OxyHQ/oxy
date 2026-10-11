import { errorHandler } from '../errorHandler';
import { ApiError, BadRequestError, InternalServerError } from '../../utils/error';

function createMockRes() {
  const res: any = {};
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
