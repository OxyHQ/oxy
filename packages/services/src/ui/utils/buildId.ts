/**
 * The identity of the JS bundle that is running, used as the buster for every
 * persisted query cache the SDK owns.
 *
 * A persisted cache is restored and served before any refetch (offline-first),
 * so data written by an older build reaches components in whatever shape that
 * build used. Busting on the build means no app ever has to remember to bump a
 * version when a query's shape changes: a new build simply starts from the
 * network. Inbox shipped exactly that crash when a hand-kept buster was missed.
 *
 * `@oxy.so/app-preset`'s Babel config replaces `process.env.OXY_BUILD_ID` with
 * the commit at bundle time, node_modules included. An app that does not use
 * the preset gets a constant, which behaves like a buster that is never bumped.
 */
export function getOxyBuildId(): string {
  const buildId = typeof process === 'undefined' ? undefined : process.env.OXY_BUILD_ID;
  return buildId || 'unversioned';
}
