import pino from 'pino';

const isDev = process.env.NODE_ENV === 'development';

/**
 * Field names this logger never writes the value of (issue #972 section 12, "no
 * upstream provider key in logs").
 *
 * ## THIS IS DEFENCE IN DEPTH. IT IS NOT THE CONTROL.
 *
 * The control for a customer's BYOK credential is structural and lives
 * elsewhere: `services/kaanaCredentialControl.ts`'s `ProviderCredentialValue` holds the
 * plaintext in a `#value` — runtime-private, not merely `tsc`-private — and
 * overrides `toString`, `toJSON` and `Symbol.for('nodejs.util.inspect.custom')`,
 * the last being exactly what pino reaches for. A `ProviderCredentialValue` cannot
 * become a string by accident, whatever the field is called. Free-text error
 * messages are refused separately, by `@oxyhq/contracts`' `safeErrorTextSchema`
 * through `utils/inferenceEdgeErrors.ts`, and the inference edge's own log lines
 * are pinned by `routes/__tests__/inferenceEdge.test.ts`.
 *
 * What none of those cover is a NEW call site somewhere else in `packages/api`
 * logging a raw credential string it happens to hold. Every guarantee above is
 * per-call-site; this is the only thing in the process that applies to a call
 * site nobody has written yet.
 *
 * ## And it is a FLOOR, with a stated limit
 *
 * `*.token` matches one level of nesting, not any depth: pino's redaction is
 * path-based, so `{ a: { b: { token } } }` is NOT covered and neither is a secret
 * that arrives inside a message STRING rather than as a field. A wildcard deep
 * enough to cover every shape would have to walk every log line, which is the
 * cost this logger cannot pay on the request path. So: never treat a value as
 * safe to log because this list exists.
 *
 * `error()` below merges an `Error` into `err`, so the `*.` arms also cover
 * `err.token` and friends.
 */
const REDACTED_PATHS = [
  'authorization',
  '*.authorization',
  'apiKey',
  '*.apiKey',
  'api_key',
  '*.api_key',
  'secret',
  '*.secret',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'deviceSecret',
  '*.deviceSecret',
  'clientSecret',
  '*.clientSecret',
  'password',
  '*.password',
  // Express's own request shape, for any middleware that logs `{ req }`.
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
];

/** What appears in place of a redacted value. */
const CENSOR = '[redacted]';

const pinoLogger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  redact: { paths: REDACTED_PATHS, censor: CENSOR },
  ...(isDev
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4,
}

export interface LogContext {
  [key: string]: unknown;
}

class Logger {
  setLevel(level: LogLevel): void {
    const map: Record<LogLevel, string> = {
      [LogLevel.DEBUG]: 'debug',
      [LogLevel.INFO]: 'info',
      [LogLevel.WARN]: 'warn',
      [LogLevel.ERROR]: 'error',
      [LogLevel.NONE]: 'silent',
    };
    pinoLogger.level = map[level] || 'info';
  }

  debug(message: string, context?: LogContext): void {
    if (context) {
      pinoLogger.debug(context, message);
    } else {
      pinoLogger.debug(message);
    }
  }

  info(message: string, context?: LogContext): void {
    if (context) {
      pinoLogger.info(context, message);
    } else {
      pinoLogger.info(message);
    }
  }

  warn(message: string, context?: LogContext): void {
    if (context) {
      pinoLogger.warn(context, message);
    } else {
      pinoLogger.warn(message);
    }
  }

  error(message: string, error?: Error | unknown, context?: LogContext): void {
    const merged: Record<string, unknown> = { ...context };
    if (error instanceof Error) {
      merged.err = { message: error.message, stack: error.stack, name: error.name };
    } else if (error && typeof error === 'object') {
      Object.assign(merged, error);
    } else if (error !== undefined && error !== null) {
      merged.errorValue = error;
    }
    pinoLogger.error(merged, message);
  }

  errorWithStack(message: string, error: Error, context?: LogContext): void {
    this.error(message, error, context);
  }

  performance(operation: string, duration: number, context?: LogContext): void {
    const msg = `${operation} completed in ${duration}ms`;
    const merged = { ...context, operation, duration };
    if (duration > 1000) {
      pinoLogger.warn(merged, msg);
    } else {
      pinoLogger.info(merged, msg);
    }
  }
}

export const logger = new Logger();
