/**
 * `OxyDeviceSignIn` — sign-in for a device with no keyboard. It owns one
 * QR-only request, and its QR is the request's https approval page (any phone
 * camera opens it), never the Commons deep link.
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
  authorizeCode: 'a1b2c3',
  qrPayload: 'oxycommons://approve?v=1&code=a1b2c3',
  approvalUrl: 'https://auth.oxy.so/device?user_code=a1b2c3',
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
      'https://auth.oxy.so/device?user_code=a1b2c3',
    );
    expect(screen.getByTestId('device-sign-in-code').textContent).toBe('a1b2c3');
    expect(screen.getByText('Sign in with your phone')).toBeTruthy();
    expect(screen.getByText("Scan with your phone's camera")).toBeTruthy();
    // A live request it already has is not replaced.
    expect(controller.startInlineQr).not.toHaveBeenCalled();
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
