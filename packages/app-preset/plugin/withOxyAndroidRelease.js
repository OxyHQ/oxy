/**
 * Removed in `@oxy.so/app-preset` 5.0.0. It stays only to fail with the fix
 * instead of an unresolvable module path; it does nothing else.
 *
 * Release signing moved to `@oxy.so/services/plugins/withOxySharedPermissions`
 * (services 13.4.0), which every Oxy Android app already applies (directly or
 * through `['@oxy.so/app-preset', {}]`): an app cannot declare the Oxy signature
 * permissions without its release being signed with, and checked against, the
 * ecosystem certificate. The R8 `-optimize` swap moved into
 * `['@oxy.so/app-preset', {}]`.
 */
module.exports = function withOxyAndroidRelease() {
  throw new Error(
    '[@oxy.so/app-preset] plugin/withOxyAndroidRelease was removed in 5.0.0. Delete it from the ' +
      'app config: release signing is applied by @oxy.so/services/plugins/withOxySharedPermissions ' +
      "(@oxy.so/services 13.4.0 or later, also applied by ['@oxy.so/app-preset', {}]), and it now " +
      'FAILS a release build that is not signed with the Oxy ecosystem key. The R8 -optimize ' +
      "ProGuard swap is applied by ['@oxy.so/app-preset', {}].",
  );
};
