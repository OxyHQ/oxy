import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Identity-binding invariant for the Commons root layout.
 *
 * Commons is the identity vault: its session MUST be pinned to the owner of this
 * device's primary identity key, not to whichever account the shared
 * `DeviceSession` happens to be switched to by a sibling Oxy app. That is exactly
 * what `sessionMode="identity"` on `OxyProvider` buys — the SDK's
 * `identity-key-signin` cold-boot lane, pinned token mints, and an inert account
 * switcher. Dropping the prop would silently downgrade the vault to following the
 * device's active account, with no type error and no runtime crash: the app would
 * simply start rendering somebody else's account.
 *
 * `app/_layout.tsx` transitively pulls in the whole navigation + splash + theming
 * stack, so rendering it in jsdom would need a dozen throw-away module stubs and
 * would assert far less than it costs. Reading the mount site is the precise,
 * stable way to guard the one configuration line that matters — the same
 * source-assertion approach `@oxyhq/core` uses for its shipped-regex policy.
 */
const ROOT_LAYOUT_SOURCE = readFileSync(
  join(__dirname, '..', '..', 'app', '_layout.tsx'),
  'utf8',
);

describe('Commons root layout', () => {
  it('mounts exactly one OxyProvider', () => {
    expect(ROOT_LAYOUT_SOURCE.match(/<OxyProvider\b/g)).toHaveLength(1);
  });

  it('binds that provider to the device identity (sessionMode="identity")', () => {
    expect(ROOT_LAYOUT_SOURCE).toMatch(/<OxyProvider\b[^>]*sessionMode="identity"/);
  });

  it('passes the registered Commons clientId (cross-app device sign-in depends on it)', () => {
    expect(ROOT_LAYOUT_SOURCE).toMatch(/<OxyProvider\b[^>]*clientId=\{OXY_CLIENT_ID\}/);
  });

  it('keeps session restore in the SDK — no app-local auto-connect driver', () => {
    // The boot-time "connect the session from the local key" driver lives in
    // `@oxyhq/core`'s cold boot now. Re-adding an app-local one would race the
    // SDK's pinned lanes and re-create the duplication this app deleted.
    expect(ROOT_LAYOUT_SOURCE).not.toMatch(/useSessionAutoConnect|sessionConnectStore/);
  });

  it('mounts shared connection-status toasts at the app root', () => {
    expect(ROOT_LAYOUT_SOURCE).toMatch(
      /import\s+\{\s*ConnectionStatusToasts\s*\}\s+from\s+'@oxyhq\/bloom\/connection-status'/,
    );
    expect(ROOT_LAYOUT_SOURCE).toMatch(/<ConnectionStatusToasts\s*\/>/);
    // Outside OxyProvider so offline toasts still render during the boot shell.
    const providerIdx = ROOT_LAYOUT_SOURCE.indexOf('<OxyProvider');
    const toastIdx = ROOT_LAYOUT_SOURCE.indexOf('<ConnectionStatusToasts');
    expect(toastIdx).toBeGreaterThan(-1);
    expect(providerIdx).toBeGreaterThan(-1);
    expect(toastIdx).toBeLessThan(providerIdx);
  });
});
