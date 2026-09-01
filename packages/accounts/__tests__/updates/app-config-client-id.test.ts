/**
 * The Oxy Updates manifest URL is baked into the binary from `app.config.js`
 * (CommonJS, build time), while every runtime Oxy call uses `constants/oxy.ts`
 * (TypeScript, bundled). app.config.js cannot require the TypeScript constant, so
 * the client id is written in both files, and this test is what keeps them equal.
 *
 * If they diverge, the app polls one application's update channel while
 * authenticating as another, and nothing else in the build would notice.
 */

import { OXY_CLIENT_ID } from '@/constants/oxy';

const UPDATES_PLUGIN = '@oxyhq/app-preset/plugin/withOxyUpdates';

interface UpdatesPluginOptions {
  clientId?: unknown;
  channel?: unknown;
}

type PluginEntry = string | [string, UpdatesPluginOptions?];

/** The `withOxyUpdates` entries in the app config's plugins array. */
function updatesPluginEntries(): [string, UpdatesPluginOptions?][] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const appConfig = require('../../app.config.js') as { expo: { plugins: PluginEntry[] } };
  return appConfig.expo.plugins.filter(
    (entry): entry is [string, UpdatesPluginOptions?] =>
      Array.isArray(entry) && entry[0] === UPDATES_PLUGIN,
  );
}

describe('app.config.js Oxy Updates wiring', () => {
  it('registers the withOxyUpdates plugin exactly once', () => {
    expect(updatesPluginEntries()).toHaveLength(1);
  });

  it('passes the same client id the runtime constant uses', () => {
    // Guard against the assertion below passing vacuously on two empty values.
    expect(OXY_CLIENT_ID).toMatch(/^oxy_dk_[0-9a-f]{48}$/);

    const [, options] = updatesPluginEntries()[0];
    expect(options?.clientId).toBe(OXY_CLIENT_ID);
  });

  it('tracks a non-empty release channel', () => {
    const [, options] = updatesPluginEntries()[0];
    expect(typeof options?.channel).toBe('string');
    expect(options?.channel).not.toBe('');
  });
});
