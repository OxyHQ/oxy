import { TokenExpiredError, JsonWebTokenError, NotBeforeError } from 'jsonwebtoken';

export class AuthenticationError extends Error {
  public statusCode: number;
  public code: string;

  constructor(message: string, statusCode = 401, code = 'INVALID_SESSION') {
    super(message);
    this.name = 'AuthenticationError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const handleJWTError = (error: Error): AuthenticationError => {
  if (error instanceof TokenExpiredError) {
    return new AuthenticationError('Token has expired', 401, 'TOKEN_EXPIRED');
  }
  if (error instanceof NotBeforeError) {
    return new AuthenticationError('Token not yet valid', 401, 'TOKEN_NOT_YET_VALID');
  }
  if (error instanceof JsonWebTokenError) {
    if (error.message === 'invalid signature') {
      return new AuthenticationError('Token signature is invalid', 401, 'INVALID_SIGNATURE');
    }
    if (error.message === 'jwt malformed') {
      return new AuthenticationError('Token format is invalid', 401, 'MALFORMED_TOKEN');
    }
  }
  return new AuthenticationError('Invalid authentication token', 401, 'INVALID_SESSION');
};

export const createErrorResponse = (error: Error) => {
  const authError = error instanceof AuthenticationError ? error : handleJWTError(error);

  return {
    error: {
      message: authError.message,
      code: authError.code || authError.statusCode,
    },
  };
};
