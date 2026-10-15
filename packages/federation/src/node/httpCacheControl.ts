/** Shared discovery config validation; zero forbids downstream response retention. */
export function discoveryCacheControl(value: number | undefined, defaultSeconds: number): string {
  const seconds = value ?? defaultSeconds;
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86400) {
    throw new RangeError('httpCacheTtlSeconds must be an integer from 0 to 86400');
  }
  return seconds === 0 ? 'no-store' : `max-age=${seconds}`;
}
