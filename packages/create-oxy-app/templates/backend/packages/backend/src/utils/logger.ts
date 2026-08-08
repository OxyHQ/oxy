/* eslint-disable no-console */
// The single logging abstraction for the backend. Swap the implementation
// (pino, etc.) here without touching call sites.
export const logger = {
  // `debug` and `info` are what @oxyhq/db's migrator expects of a logger, so
  // this object can be handed to `runMigrations` directly.
  debug: (message: string, ...args: unknown[]): void => console.debug(`[debug] ${message}`, ...args),
  info: (message: string, ...args: unknown[]): void => console.log(`[info] ${message}`, ...args),
  warn: (message: string, ...args: unknown[]): void => console.warn(`[warn] ${message}`, ...args),
  error: (message: string, ...args: unknown[]): void => console.error(`[error] ${message}`, ...args),
};
