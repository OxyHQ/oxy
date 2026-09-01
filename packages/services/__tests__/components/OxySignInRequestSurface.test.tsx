/**
 * `OxySignInRequestSurface` — the in-flight "Sign in with Oxy" request surface,
 * exercised as what it is: a PRESENTATIONAL component driven by plain facts.
 *
 * Every test here mounts it with props only — no `AccountDialogController`, no
 * device flow, no polling, no host. That is the seam the auth.oxy.so IdP needs
 * for its OAuth-bound lane, and proving it renders each route's primary
 * presentation from props alone is what stops a second copy of this surface
 * being written downstream (issue #691).
 *
 * The account dialog's own path through this component (controller facts →
 * `SignInRequestView` → this surface) is covered UNCHANGED by
 * `OxyAuthChooser.test.tsx` — one implementation, both hosts asserted.
 *
 * The last test is a contract guard, not a rendering one: the public prop set is
 * pinned, so no secret-bearing prop (a `sessionToken`, a bearer, an authorization
 * code) can be added to this surface without the change being deliberate.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent } from '@testing-library/react';

// Real copy from the shipped dictionaries — a renamed/missing key surfaces here
// as its raw dotted path instead of silently passing.
jest.mock('../../src/ui/hooks/useI18n', () => {
  const { translate } = jest.requireActual('@oxyhq/core');
  return {
    __esModule: true,
    useI18n: () => ({
      t: (key: string, vars?: Record<string, string | number>) => translate('en-US', key, vars),
      locale: 'en-US',
    }),
  };
});

jest.mock('react-native-qrcode-svg', () => ({
  __esModule: true,
  default: ({ value }: { value: string }) =>
    require('react').createElement('span', { 'data-testid': 'qrcode' }, value),
}));

// eslint-disable-next-line import/first
import { OxySignInRequestSurface } from '../../src/ui/components/OxySignInRequestSurface';

const QR_PAYLOAD = 'oxycommons://approve?v=1&code=CODE';

/** Every button currently on screen, in DOM order, by its visible label. */
const buttonLabels = (): (string | null)[] =>
  screen.getAllByRole('button').map((button) => button.textContent);

describe('OxySignInRequestSurface', () => {
  describe('the primary presentation, from props alone', () => {
    it('renders the QR plate + route-specific status for the qr route', () => {
      render(
        <OxySignInRequestSurface
          route="qr"
          progress="awaiting-approval"
          qrPayload={QR_PAYLOAD}
        />,
      );

      // The plate encodes the PUBLIC payload and renders nothing derived from it.
      expect(screen.getByTestId('qrcode').textContent).toBe(QR_PAYLOAD);
      expect(screen.getByText('Sign in with your Oxy identity')).toBeTruthy();
      expect(screen.getByTestId('signin-progress').textContent).toBe(
        'Scan with Commons on your phone',
      );
    });

    it('renders the delivered-to-Commons surface for the await-push route — no QR', () => {
      render(
        <OxySignInRequestSurface
          route="await-push"
          progress="delivered-to-commons"
          qrPayload={QR_PAYLOAD}
        />,
      );

      expect(screen.queryByTestId('qrcode')).toBeNull();
      expect(screen.getByTestId('signin-progress').textContent).toBe(
        'Check Commons on your phone',
      );
    });

    it('renders the hand-off surface for the open-commons route — no QR', () => {
      render(
        <OxySignInRequestSurface
          route="open-commons"
          progress="awaiting-approval"
          qrPayload={QR_PAYLOAD}
        />,
      );

      expect(screen.queryByTestId('qrcode')).toBeNull();
      expect(screen.getByTestId('signin-progress').textContent).toBe('Continue in Commons');
    });

    it('shows "Preparing request" while no route is resolved — never a guessed QR', () => {
      render(
        <OxySignInRequestSurface route={null} progress="preparing" qrPayload={QR_PAYLOAD} />,
      );

      // The payload exists, but presenting it before a route was chosen would be
      // guessing — and would flash-then-replace once the real route lands.
      expect(screen.queryByTestId('qrcode')).toBeNull();
      expect(screen.getByTestId('signin-progress').textContent).toBe('Preparing request');
    });

    it('replaces the route surface with the confirmation ladder once the request is authorized', () => {
      const { rerender } = render(
        <OxySignInRequestSurface
          route="qr"
          progress="confirming-identity"
          qrPayload={QR_PAYLOAD}
        />,
      );
      expect(screen.queryByTestId('qrcode')).toBeNull();
      expect(screen.getByTestId('signin-progress').textContent).toBe('Confirming identity');

      rerender(
        <OxySignInRequestSurface
          route="qr"
          progress="identity-confirmed"
          qrPayload={QR_PAYLOAD}
        />,
      );
      expect(screen.queryByTestId('qrcode')).toBeNull();
      expect(screen.getByTestId('signin-progress').textContent).toBe('Identity confirmed');
    });

    it('reports nothing at all while progress is idle', () => {
      render(<OxySignInRequestSurface route={null} progress="idle" />);

      expect(screen.queryByTestId('signin-progress')).toBeNull();
      expect(screen.queryByTestId('qrcode')).toBeNull();
    });

    it('never advances on its own — only a new progress prop moves the line', () => {
      jest.useFakeTimers();
      try {
        const { rerender } = render(
          <OxySignInRequestSurface
            route="qr"
            progress="awaiting-approval"
            qrPayload={QR_PAYLOAD}
          />,
        );
        jest.advanceTimersByTime(60_000);
        expect(screen.getByTestId('signin-progress').textContent).toBe(
          'Scan with Commons on your phone',
        );

        rerender(
          <OxySignInRequestSurface
            route="qr"
            progress="opened-in-commons"
            qrPayload={QR_PAYLOAD}
          />,
        );
        expect(screen.getByTestId('signin-progress').textContent).toBe('Opened in Commons');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('one primary action + progressive disclosure', () => {
    const alternatives = [
      { key: 'alt-a', label: 'Open on this device', onPress: jest.fn() },
      { key: 'alt-b', label: 'Sign in here', onPress: jest.fn() },
    ];

    beforeEach(() => {
      for (const action of alternatives) action.onPress.mockClear();
    });

    it('keeps the alternatives behind "Having trouble?" while the route is working', () => {
      render(
        <OxySignInRequestSurface
          route="qr"
          progress="awaiting-approval"
          qrPayload={QR_PAYLOAD}
          alternatives={alternatives}
        />,
      );

      expect(buttonLabels()).toEqual(['Having trouble?']);
      expect(screen.queryByTestId('alt-a')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Having trouble?' }));
      fireEvent.click(screen.getByTestId('alt-a'));

      expect(alternatives[0].onPress).toHaveBeenCalledTimes(1);
    });

    it('reveals the alternatives without a tap when the chosen route failed', () => {
      render(
        <OxySignInRequestSurface
          route="open-commons"
          progress="awaiting-approval"
          routeFailed
          alternatives={alternatives}
        />,
      );

      expect(screen.queryByRole('button', { name: 'Having trouble?' })).toBeNull();
      expect(screen.getByTestId('alt-a')).toBeTruthy();
      expect(screen.getByTestId('alt-b')).toBeTruthy();
    });

    it('renders subordinate links plainly — never behind the disclosure', () => {
      const onCancel = jest.fn();
      render(
        <OxySignInRequestSurface
          route="qr"
          progress="awaiting-approval"
          qrPayload={QR_PAYLOAD}
          subordinate={[{ key: 'cancel-link', label: 'Cancel', onPress: onCancel }]}
          alternatives={alternatives}
        />,
      );

      expect(buttonLabels()).toEqual(['Cancel', 'Having trouble?']);
      fireEvent.click(screen.getByTestId('cancel-link'));
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('honours a disabled action (an in-flight alternative is un-pressable)', () => {
      const onPress = jest.fn();
      render(
        <OxySignInRequestSurface
          route="qr"
          progress="awaiting-approval"
          qrPayload={QR_PAYLOAD}
          alternatives={[{ key: 'alt-pending', label: 'Signing in…', onPress, disabled: true }]}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Having trouble?' }));
      fireEvent.click(screen.getByTestId('alt-pending'));

      expect(onPress).not.toHaveBeenCalled();
    });
  });

  describe('a failed request', () => {
    it('leads with "Try again" and reveals the alternatives, reporting no progress', () => {
      const onRetry = jest.fn();
      render(
        <OxySignInRequestSurface
          route="qr"
          progress="idle"
          failed
          onRetry={onRetry}
          alternatives={[{ key: 'alt-a', label: 'Sign in here', onPress: jest.fn() }]}
        />,
      );

      // The REASON is the host's to surface (toast / banner) — never rendered here.
      expect(screen.queryByTestId('signin-progress')).toBeNull();
      expect(screen.queryByTestId('qrcode')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Having trouble?' })).toBeNull();
      expect(screen.getByTestId('alt-a')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('offers no retry at all when a fresh attempt cannot help', () => {
      render(
        <OxySignInRequestSurface
          route="qr"
          progress="idle"
          failed
          alternatives={[{ key: 'alt-a', label: 'Sign in here', onPress: jest.fn() }]}
        />,
      );

      // A request that would fail identically every time leaves the alternatives
      // as the only way forward — no button that loops the user through it again.
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      expect(screen.getByTestId('alt-a')).toBeTruthy();
    });
  });

  describe('a device with no Commons', () => {
    it('leads with the acquisition CTA — the genuine primary route — and no route progress', () => {
      const onAcquireCommons = jest.fn();
      render(
        <OxySignInRequestSurface
          route="qr"
          progress="awaiting-approval"
          qrPayload={QR_PAYLOAD}
          onAcquireCommons={onAcquireCommons}
          alternatives={[{ key: 'show-qr-anyway-link', label: 'I have Commons on another device', onPress: jest.fn() }]}
        />,
      );

      expect(screen.getByTestId('get-commons-button')).toBeTruthy();
      // A same-device QR would be a dead end, so it is demoted behind the
      // disclosure rather than shown next to the acquisition CTA.
      expect(screen.queryByTestId('qrcode')).toBeNull();
      expect(screen.queryByTestId('signin-progress')).toBeNull();
      expect(screen.queryByTestId('show-qr-anyway-link')).toBeNull();

      fireEvent.click(screen.getByTestId('get-commons-button'));
      expect(onAcquireCommons).toHaveBeenCalledTimes(1);
    });
  });

  describe('public prop contract', () => {
    it('exposes no secret-bearing prop', () => {
      const source = readFileSync(
        join(__dirname, '../../src/ui/components/OxySignInRequestSurface.tsx'),
        'utf8',
      );
      const body = source.split('export interface OxySignInRequestSurfaceProps {')[1]?.split('\n}')[0];
      expect(body).toBeDefined();

      // Property declarations only — doc comments and nested option types are not
      // part of the prop inventory.
      const props = [...(body ?? '').matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1]);

      // The FULL inventory. A new prop must be added here deliberately, which is
      // where a credential-shaped one gets caught in review.
      expect(props.sort()).toEqual([
        'alternatives',
        'failed',
        'onAcquireCommons',
        'onRetry',
        'progress',
        'qrPayload',
        'route',
        'routeFailed',
        'subordinate',
      ]);

      // Nothing that could carry the secret claim/finalize credential, a bearer,
      // or the authorization code itself — those stay in the host's controller.
      for (const prop of props) {
        expect(prop).not.toMatch(/token|secret|password|credential|bearer|cookie|authorizeCode/i);
      }
    });
  });
});
