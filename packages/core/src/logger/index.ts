/**
 * @oxy.so/core/logger — the ecosystem-wide logging chokepoint.
 *
 * A tiny, dependency-free, universal logger that works unchanged in React
 * Native, browsers, Node, and Bun. Every Oxy app and package should log
 * through here instead of calling `console.*` directly, so that level,
 * formatting, and transport are controlled in ONE place.
 *
 * Design goals:
 *  - Zero dependencies. No Node-only imports, no `process.stdout` assumptions.
 *  - Four levels (`debug` | `info` | `warn` | `error`) plus `silent`.
 *  - Namespaced child loggers via `createLogger('mention:feed')` / `.child()`.
 *  - Structured context objects carried through to the sink.
 *  - A single pluggable sink so backends can pipe to pino / CloudWatch / etc.
 *    without touching any call site.
 *  - Debug is off in production by default (`__DEV__` on RN, `NODE_ENV`
 *    elsewhere); override globally with `configureLogger({ level })`.
 *
 * @module logger
 */

/* global __DEV__ */
declare const __DEV__: boolean | undefined;

/** Ordered severity levels. `silent` disables all output. */
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

/** The levels that actually emit an entry (everything but `silent`). */
export type EmittableLogLevel = Exclude<LogLevel, 'silent'>;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

/**
 * Structured, JSON-friendly context attached to a log line. The well-known
 * keys are optional hints; arbitrary keys are allowed so callers can attach
 * whatever structured fields their sink cares about.
 */
export interface LogContext {
  component?: string;
  method?: string;
  userId?: string;
  sessionId?: string;
  requestId?: string;
  [key: string]: unknown;
}

/** A single normalized log record handed to the active sink. */
export interface LogEntry {
  level: EmittableLogLevel;
  message: string;
  /** Colon-joined namespace, e.g. `mention:feed`. Absent for the root logger. */
  namespace?: string;
  /** Merged structured context (logger base context + per-call context). */
  context?: LogContext;
  /** The error value passed to `.error(message, error, …)`, if any. */
  error?: unknown;
  /** Extra variadic args passed after the context. */
  args: unknown[];
  /** ISO-8601 timestamp of when the entry was created. */
  timestamp: string;
}

/** A transport that receives every emitted (level-passing) entry. */
export type LogSink = (entry: LogEntry) => void;

/** Global logger configuration. */
export interface LoggerConfig {
  level: LogLevel;
  sink: LogSink;
}

/** A namespaced logger. Instances are cheap; derive children with `.child()`. */
export interface Logger {
  /** The logger's colon-joined namespace, if any. */
  readonly namespace?: string;
  debug(message: string, context?: LogContext, ...args: unknown[]): void;
  info(message: string, context?: LogContext, ...args: unknown[]): void;
  warn(message: string, context?: LogContext, ...args: unknown[]): void;
  error(message: string, error?: unknown, context?: LogContext, ...args: unknown[]): void;
  /** Derive a child logger with an extended namespace and merged base context. */
  child(namespace: string, context?: LogContext): Logger;
}

/**
 * True in development. Uses React Native's `__DEV__` when present, otherwise
 * falls back to `process.env.NODE_ENV === 'development'`. Never throws.
 */
export function isDev(): boolean {
  if (typeof __DEV__ !== 'undefined') return __DEV__ === true;
  try {
    return typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';
  } catch {
    return false;
  }
}

function formatPrefix(entry: LogEntry): string {
  const parts = [entry.timestamp, entry.level.toUpperCase()];
  if (entry.namespace) parts.push(`[${entry.namespace}]`);
  return parts.join(' ');
}

/**
 * Default sink: routes each entry to the matching `console` method. `info` and
 * `debug` go to `console.log` (RN/browser-safe — `console.debug`/`console.info`
 * are inconsistently surfaced across runtimes).
 */
export const consoleSink: LogSink = (entry) => {
  const extras: unknown[] = [];
  if (entry.context && Object.keys(entry.context).length > 0) extras.push(entry.context);
  if (entry.error !== undefined) extras.push(entry.error);
  if (entry.args.length > 0) extras.push(...entry.args);

  const line = `${formatPrefix(entry)} ${entry.message}`;
  if (entry.level === 'error') console.error(line, ...extras);
  else if (entry.level === 'warn') console.warn(line, ...extras);
  else console.log(line, ...extras);
};

function defaultLevel(): LogLevel {
  return isDev() ? 'debug' : 'info';
}

const config: LoggerConfig = {
  level: defaultLevel(),
  sink: consoleSink,
};

/**
 * Update the global logger configuration. Affects every logger instance
 * (root and children) immediately. Pass `{ level }` to gate output and/or
 * `{ sink }` to redirect transport (pino, CloudWatch, a test capture, …).
 */
export function configureLogger(partial: Partial<LoggerConfig>): void {
  if (partial.level !== undefined) config.level = partial.level;
  if (partial.sink !== undefined) config.sink = partial.sink;
}

/** Read a snapshot of the current global configuration. */
export function getLoggerConfig(): Readonly<LoggerConfig> {
  return { level: config.level, sink: config.sink };
}

/** Restore the default level (env-derived) and the console sink. */
export function resetLoggerConfig(): void {
  config.level = defaultLevel();
  config.sink = consoleSink;
}

function mergeContext(base?: LogContext, extra?: LogContext): LogContext | undefined {
  if (!base) return extra;
  if (!extra) return base;
  return { ...base, ...extra };
}

function emit(
  level: EmittableLogLevel,
  namespace: string | undefined,
  baseContext: LogContext | undefined,
  message: string,
  error: unknown,
  context: LogContext | undefined,
  args: unknown[],
): void {
  if (LEVEL_WEIGHT[level] > LEVEL_WEIGHT[config.level]) return;
  config.sink({
    level,
    message,
    namespace,
    context: mergeContext(baseContext, context),
    error,
    args,
    timestamp: new Date().toISOString(),
  });
}

function makeLogger(namespace: string | undefined, baseContext: LogContext | undefined): Logger {
  return {
    namespace,
    debug: (message, context, ...args) =>
      emit('debug', namespace, baseContext, message, undefined, context, args),
    info: (message, context, ...args) =>
      emit('info', namespace, baseContext, message, undefined, context, args),
    warn: (message, context, ...args) =>
      emit('warn', namespace, baseContext, message, undefined, context, args),
    error: (message, error, context, ...args) =>
      emit('error', namespace, baseContext, message, error, context, args),
    child: (childNamespace, childContext) =>
      makeLogger(
        namespace ? `${namespace}:${childNamespace}` : childNamespace,
        mergeContext(baseContext, childContext),
      ),
  };
}

/** The shared root logger. Prefer a namespaced `createLogger(...)` in modules. */
export const logger: Logger = makeLogger(undefined, undefined);

/**
 * Create a namespaced logger.
 *
 * @example
 * ```ts
 * const log = createLogger('mention:feed');
 * log.info('loaded', { count: 20 });
 * const sub = log.child('prefetch'); // namespace → 'mention:feed:prefetch'
 * ```
 */
export function createLogger(namespace?: string, context?: LogContext): Logger {
  return makeLogger(namespace, context);
}
