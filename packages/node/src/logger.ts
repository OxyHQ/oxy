/**
 * Minimal structured logger for the node, built on pino (the same logger
 * `@oxy.so/api` uses). Level is env-driven via `OXY_NODE_LOG_LEVEL` (default
 * `info`). No secrets are ever logged.
 */

import pino, { type Logger } from 'pino';

export type { Logger };

/** Create the node's root logger. */
export function createLogger(): Logger {
  return pino({
    name: 'oxy-node',
    level: process.env.OXY_NODE_LOG_LEVEL ?? 'info',
  });
}
