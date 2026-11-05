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

/**
 * The longest update message the API accepts, in UTF-16 code units
 * (`message` in `@oxy.so/contracts`' `updates.ts`). Mirrored here because the
 * contracts package is a type-only dependency of the CLI.
 */
export const UPDATE_MESSAGE_MAX_LENGTH = 500;

/**
 * The update message to send for a `--message` value: its first non-empty line,
 * trimmed, shortened to {@link UPDATE_MESSAGE_MAX_LENGTH} UTF-16 units with an
 * ellipsis and without splitting a surrogate pair. A CI caller passes a whole
 * commit message (a squash merge's body runs to thousands of characters); the
 * API would refuse it with 422 after the export and upload had already run.
 * `undefined` for an absent or blank value.
 */
export function updateMessage(raw: string | undefined): string | undefined {
  const line = raw
    ?.split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return undefined;
  if (line.length <= UPDATE_MESSAGE_MAX_LENGTH) return line;
  let end = UPDATE_MESSAGE_MAX_LENGTH - 1;
  const last = line.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${line.slice(0, end).trimEnd()}…`;
}
