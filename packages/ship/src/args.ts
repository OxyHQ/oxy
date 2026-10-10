import { parseArgs as nodeParseArgs } from 'node:util';

/**
 * Parsed CLI invocation. Built on Node's stdlib `util.parseArgs` — the command
 * is the first positional (e.g. `publish`, `channel:list`); flags are the
 * declared options. oxy-ship is a CI tool, so parsing is strict (a typo'd flag
 * errors clearly rather than being silently ignored).
 */
export type ShipFlags = Record<string, string | boolean | undefined>;

export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: ShipFlags;
}

/** Every option oxy-ship accepts, across all commands. */
const OPTIONS = {
  channel: { type: 'string' },
  platform: { type: 'string' },
  rollout: { type: 'string' },
  message: { type: 'string' },
  'runtime-version': { type: 'string' },
  url: { type: 'string' },
  'api-url': { type: 'string' },
  'dist-dir': { type: 'string' },
  'project-dir': { type: 'string' },
  'git-commit': { type: 'string' },
  'git-branch': { type: 'string' },
  'update-id': { type: 'string' },
  'to-channel': { type: 'string' },
  limit: { type: 'string' },
  'client-id': { type: 'string' },
  secret: { type: 'string' },
  'skip-export': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean' },
} as const;

export function parseArgs(argv: string[]): ParsedArgs {
  const { values, positionals } = nodeParseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });
  return {
    command: positionals[0],
    positionals: positionals.slice(1),
    flags: values as ShipFlags,
  };
}

/** Read a string flag, falling back to an env var, then a default. */
export function stringFlag(
  flags: ShipFlags,
  name: string,
  envVar?: string,
  fallback?: string,
): string | undefined {
  const value = flags[name];
  if (typeof value === 'string') return value;
  if (envVar && process.env[envVar]) return process.env[envVar];
  return fallback;
}

/** Read a required string flag/env; throw a clear error when missing. */
export function requireString(flags: ShipFlags, name: string, envVar: string): string {
  const value = stringFlag(flags, name, envVar);
  if (!value) {
    throw new Error(`Missing --${name} (or ${envVar})`);
  }
  return value;
}

/** Parse an integer flag within [0, 100], or undefined when absent. */
export function rolloutFlag(flags: ShipFlags): number | undefined {
  const value = flags.rollout;
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new Error('--rollout must be an integer between 0 and 100');
  }
  return parsed;
}

/** Resolve the target platforms from `--platform` (default: both). */
export function platformsFlag(flags: ShipFlags): Array<'ios' | 'android'> {
  const value = flags.platform;
  if (value === undefined || value === 'all') {
    return ['ios', 'android'];
  }
  const normalized = String(value).toLowerCase();
  if (normalized !== 'ios' && normalized !== 'android') {
    throw new Error('--platform must be ios, android, or all');
  }
  return [normalized];
}

/** Resolve the API base URL from `--url`, then `--api-url`/`OXY_API_URL`, then the default. */
export function baseUrlFlag(flags: ShipFlags): string {
  const explicit = stringFlag(flags, 'url');
  if (explicit) return explicit;
  return stringFlag(flags, 'api-url', 'OXY_API_URL', 'https://api.oxy.so') ?? 'https://api.oxy.so';
}
