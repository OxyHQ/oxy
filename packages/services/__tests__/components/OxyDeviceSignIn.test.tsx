/**
 * `OxyDeviceSignIn` — sign-in for a device with no keyboard. It owns one
 * QR-only request, and its QR is the request's https approval page (any phone
 * camera opens it), never the Commons deep link. It draws no heading (the host
 * screen owns that) and its code grows with the QR.
 */

import { act, render, screen } from '@testing-library/react';
import type { AccountDialogSnapshot, SignInFlowState } from '@oxy.so/core/session';

const IDLE_SIGN_IN: SignInFlowState = {
  phase: 'idle',
  authorizeCode: null,
  qrPayload: null,
  approvalUrl: null,
  expiresAt: null,
  error: null,
  failure: null,
  route: null,
  routeFailed: false,
  pushSentAt: null,
  openedAt: null,
  progress: 'idle',
  attempt: 0,
  inline: false,
};

const WAITING: SignInFlowState = {
  ...IDLE_SIGN_IN,
  phase: 'waiting',
  inline: true,
  route: 'qr',
  progress: 'awaiting-approval',
  authorizeCode: 'ce7fb31f067a617a668827f424f487eb',
  qrPayload: 'oxycommons://approve?v=1&code=ce7fb31f067a617a668827f424f487eb',
  approvalUrl: 'https://auth.oxy.so/device?user_code=ce7fb31f067a617a668827f424f487eb',
};

const makeSnapshot = (signIn: SignInFlowState): AccountDialogSnapshot => ({
  view: 'signin',
  backView: null,
  hasSession: false,
  directory: null,
  activeContext: null,
  loading: false,
  error: null,
  activatingContextId: null,
  removingContextId: null,
  removingPrincipalId: null,
  signIn,
  commonsAvailability: 'unknown',
});

let snapshot = makeSnapshot(IDLE_SIGN_IN);
let listeners: Array<() => void> = [];
const emit = (signIn: SignInFlowState) => {
  snapshot = makeSnapshot(signIn);
  for (const listener of listeners) listener();
};

const controller = {
  subscribe: jest.fn((listener: () => void) => {
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  }),
  getSnapshot: () => snapshot,
  startInlineQr: jest.fn(async () => undefined),
  cancelSignIn: jest.fn(),
};

jest.mock('../../src/ui/context/oxyRuntimeContext', () => ({
  __esModule: true,
  useOxy: () => ({ accountDialogController: controller }),
  useOptionalOxy: () => null,
}));

jest.mock('../../src/ui/hooks/useI18n', () => {
  const { translate } = jest.requireActual('@oxy.so/core');
  return {
    __esModule: true,
    useI18n: () => ({
      t: (key: string, vars?: Record<string, string | number>) => translate('en-US', key, vars),
      locale: 'en-US',
    }),
  };
});

// Every `@oxy.so/bloom/*` subpath maps to the one shared Bloom mock; keep it
// and let `Code` also show the size it is given.
jest.mock('@oxy.so/bloom/code', () => {
  const React = jest.requireActual('react');
  return {
    ...jest.requireActual('@oxy.so/bloom/code'),
    Code: ({
      children,
      testID,
      style,
    }: {
      children: unknown;
      testID?: string;
      style?: { fontSize?: number };
    }) =>
      React.createElement(
        'code',
        { 'data-testid': testID, 'data-font-size': style?.fontSize },
        children,
      ),
  };
});

jest.mock('react-native-qrcode-svg', () => ({
  __esModule: true,
  default: ({ value }: { value: string }) =>
    require('react').createElement('span', { 'data-testid': 'qrcode' }, value),
}));

import { OxyDeviceSignIn } from '../../src/ui/components/OxyDeviceSignIn';

beforeEach(() => {
  snapshot = makeSnapshot(IDLE_SIGN_IN);
  listeners = [];
  controller.startInlineQr.mockClear();
  controller.cancelSignIn.mockClear();
});

describe('OxyDeviceSignIn', () => {
  it('asks for one QR-only request as soon as it is on screen', () => {
    render(<OxyDeviceSignIn />);
    expect(controller.startInlineQr).toHaveBeenCalledTimes(1);
  });

  it('encodes the https approval page, not the Commons deep link, and shows the code to compare', () => {
    snapshot = makeSnapshot(WAITING);
    render(<OxyDeviceSignIn />);

    expect(screen.getByTestId('qrcode').textContent).toBe(
      'https://auth.oxy.so/device?user_code=ce7fb31f067a617a668827f424f487eb',
    );
    // The short code the approval page prints too, never the whole handle.
    expect(screen.getByTestId('device-sign-in-code').textContent).toBe('CE7F-B31F');
    // A live request it already has is not replaced.
    expect(controller.startInlineQr).not.toHaveBeenCalled();
  });

  it('draws no heading of its own: the host screen says what is being set up', () => {
    snapshot = makeSnapshot(WAITING);
    render(<OxyDeviceSignIn />);
    // Only the hint and the code remain beside the QR.
    expect(screen.getByTestId('oxy-device-sign-in').textContent).toBe(
      'https://auth.oxy.so/device?user_code=ce7fb31f067a617a668827f424f487eb' +
        'Check that your phone shows this code' +
        'CE7F-B31F',
    );
  });

  it('scales the code with the QR, so it stays legible across a room', () => {
    snapshot = makeSnapshot(WAITING);
    const fontSizeAt = (size: number) => {
      const view = render(<OxyDeviceSignIn size={size} />);
      const fontSize = screen.getByTestId('device-sign-in-code').getAttribute('data-font-size');
      view.unmount();
      return fontSize;
    };
    expect(fontSizeAt(280)).toBe('28');
    expect(fontSizeAt(480)).toBe('48');
  });

  it('hides the QR and the code once the phone is confirming', () => {
    snapshot = makeSnapshot({ ...WAITING, progress: 'confirming-identity' });
    render(<OxyDeviceSignIn />);
    expect(screen.queryByTestId('qrcode')).toBeNull();
    expect(screen.queryByTestId('device-sign-in-code')).toBeNull();
  });

  it('replaces an expired code by itself', () => {
    render(<OxyDeviceSignIn />);
    controller.startInlineQr.mockClear();
    act(() => emit({ ...IDLE_SIGN_IN, phase: 'error', failure: 'expired', inline: true }));
    expect(controller.startInlineQr).toHaveBeenCalledTimes(1);
  });

  it('withdraws its own live request on the way out, and leaves anyone else’s alone', () => {
    snapshot = makeSnapshot(WAITING);
    render(<OxyDeviceSignIn />).unmount();
    expect(controller.cancelSignIn).toHaveBeenCalledTimes(1);

    controller.cancelSignIn.mockClear();
    snapshot = makeSnapshot({ ...WAITING, inline: false });
    render(<OxyDeviceSignIn />).unmount();
    expect(controller.cancelSignIn).not.toHaveBeenCalled();
  });
});
