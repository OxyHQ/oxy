import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { act, renderHook, waitFor } from '@testing-library/react';
import { __getMockRouter } from '@/__mocks__/expo-router';
import {
  __emitNotificationResponse,
  __getForegroundDecision,
  __hasNotificationResponseListener,
  __resetNotificationAdapter,
  installForegroundNotificationHandler,
} from '@/__mocks__/oxyhq-services';
import { COMMONS_AUTH_REQUEST_PUSH_TYPE } from '@/lib/notifications/auth-request-push';
import { useForegroundNotificationHandler } from '@/hooks/notifications/useForegroundNotificationHandler';
import { useAuthRequestNotifications } from '@/hooks/notifications/useAuthRequestNotifications';

const router = __getMockRouter();

function pushPayload(approvalUrl: string): Record<string, unknown> {
  return { type: COMMONS_AUTH_REQUEST_PUSH_TYPE, approvalUrl };
}

/**
 * Presentation of "Sign in with Oxy" approval requests while Commons is the
 * FOREGROUNDED app.
 *
 * Notifications show nothing at all in the foreground unless an app-global
 * handler says otherwise, so a request that arrives while the user is looking at
 * Commons would be invisible — the one moment they are demonstrably holding the
 * phone. These tests pin the rule that fixes it, AND pin that fixing it did not
 * hand the notification any new powers.
 *
 * The install itself belongs to the shared `@oxyhq/services` adapter (which owns
 * the one-shot latch, the native-only guard, and the banner/list/sound/badge
 * shape, all tested in that package). What Commons owns — and what is asserted
 * here — is the POLICY it hands that adapter: which payload earns a banner.
 */
describe('foreground notification presentation', () => {
  beforeEach(() => {
    router.push.mockClear();
    router.replace.mockClear();
    __resetNotificationAdapter();
  });

  it('installs a presentation policy on mount', async () => {
    renderHook(() => useForegroundNotificationHandler());

    await waitFor(() => expect(installForegroundNotificationHandler).toHaveBeenCalledTimes(1));
  });

  it('never tears the policy down — the handler is process-wide, not per-mount', async () => {
    const { unmount } = renderHook(() => useForegroundNotificationHandler());
    await waitFor(() => expect(installForegroundNotificationHandler).toHaveBeenCalled());

    unmount();

    // Nothing to uninstall: the adapter holds the one global handler for the
    // life of the process, so unmounting a screen must not silence push.
    expect(installForegroundNotificationHandler).toHaveBeenCalledTimes(1);
  });

  it('shows a sign-in approval request that arrives while Commons is open', async () => {
    renderHook(() => useForegroundNotificationHandler());
    await waitFor(() => expect(installForegroundNotificationHandler).toHaveBeenCalled());

    expect(__getForegroundDecision()(pushPayload('oxycommons://approve?v=1&code=fg-1'))).toBe(
      'show',
    );
  });

  it.each([
    [
      'a notification that is not ours',
      { type: 'marketing', approvalUrl: 'oxycommons://approve?code=x' },
    ],
    ['a foreign scheme', pushPayload('evil://approve?code=x')],
    ['a missing authorize code', pushPayload('oxycommons://approve?v=1')],
    ['an already-stale link', pushPayload(`oxycommons://approve?code=x&exp=${Date.now() - 60_000}`)],
    ['a payload that is not an object', 'oxycommons://approve?code=x'],
    ['an empty payload', {}],
  ])('suppresses %s — the documented default for everything else', async (_label, data) => {
    renderHook(() => useForegroundNotificationHandler());
    await waitFor(() => expect(installForegroundNotificationHandler).toHaveBeenCalled());

    expect(__getForegroundDecision()(data)).toBe('suppress');
  });

  it('decides visibility ONLY — presenting one navigates nowhere', async () => {
    renderHook(() => useForegroundNotificationHandler());
    await waitFor(() => expect(installForegroundNotificationHandler).toHaveBeenCalled());

    __getForegroundDecision()(pushPayload('oxycommons://approve?v=1&code=fg-2'));

    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('leaves a TAP doing only what it did before: open /approve with only the code', async () => {
    renderHook(() => useForegroundNotificationHandler());
    renderHook(() => useAuthRequestNotifications(true));
    await waitFor(() => expect(__hasNotificationResponseListener()).toBe(true));

    act(() => {
      __emitNotificationResponse({
        ...pushPayload('oxycommons://approve?v=1&code=fg-tap&app=Evil%20Bank'),
        appName: 'Evil Bank',
        body: 'Approve now',
      });
    });

    expect(router.push).toHaveBeenCalledTimes(1);
    const [target] = router.push.mock.calls[0] as [
      { pathname: string; params: Record<string, string> },
    ];
    expect(target.pathname).toBe('/approve');
    // Nothing from the payload rides along — not the app name, not the body.
    expect(target.params).toEqual({ code: 'fg-tap' });
    expect(Object.keys(target.params)).toEqual(['code']);
  });
});

/**
 * The banner may never grow an "Approve" button.
 *
 * A notification gains action buttons only through `expo-notifications`'
 * category API, and the shared SDK adapter exposes no way to register one — its
 * entire notification surface is permission, token, launch payload, a
 * show/suppress verdict, and tap subscription. So the guarantee reduces to a
 * structural one: Commons reaches `expo-notifications` ONLY through that
 * adapter, never directly.
 *
 * That is a source-level fact, and reading the source is the precise way to
 * assert it — the same approach `__tests__/app/root-layout.test.ts` uses for the
 * provider's identity binding. `expo-notifications` stays a package.json
 * dependency on purpose: Commons ships the native module, it just no longer
 * calls it.
 */
describe('Commons notification surface', () => {
  const APP_ROOT = join(__dirname, '..', '..');
  const SOURCE_DIRECTORIES = ['app', 'components', 'constants', 'hooks', 'lib', 'utils'];
  const SKIPPED_DIRECTORIES = new Set(['node_modules', '__tests__', '__mocks__']);

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return SKIPPED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(path);
      }
      return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
  }

  const FILES = SOURCE_DIRECTORIES.flatMap((directory) => sourceFiles(join(APP_ROOT, directory)));

  it('scans a source tree (guards against the walker silently finding nothing)', () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it('imports expo-notifications nowhere — the SDK adapter is the only door', () => {
    const offenders = FILES.filter((file) =>
      /from\s+['"]expo-notifications['"]|import\(\s*['"]expo-notifications['"]|require\(\s*['"]expo-notifications['"]/.test(
        readFileSync(file, 'utf8'),
      ),
    );

    expect(offenders).toEqual([]);
  });
});
