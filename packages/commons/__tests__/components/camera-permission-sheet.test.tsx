import type React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { AppState, Linking, Platform } from 'react-native';
import { LocaleProvider } from '@/lib/i18n/locale-context';

interface MockAction {
  label: string;
  color?: string;
  onPress?: () => void;
  shouldCloseOnPress?: boolean;
}

interface MockDialogProps {
  title?: string;
  description?: string;
  actions?: MockAction[];
}

let mockDialogProps: MockDialogProps | null = null;
let mockDialogControl: { open: jest.Mock; close: jest.Mock } | null = null;

jest.mock('@oxyhq/bloom/dialog', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react') as typeof import('react');
  return {
    useDialogControl: () => {
      const controlRef = R.useRef<{ open: jest.Mock; close: jest.Mock } | null>(null);
      if (!controlRef.current) {
        controlRef.current = { open: jest.fn(), close: jest.fn() };
      }
      mockDialogControl = controlRef.current;
      return controlRef.current;
    },
    Dialog: (props: MockDialogProps & { children?: React.ReactNode }) => {
      mockDialogProps = props;
      return null;
    },
  };
});

// Imported after Bloom is mocked so the component binds to the action contract.
// eslint-disable-next-line import/first
import { CameraPermissionSheet } from '@/components/civic/CameraPermissionSheet';

function renderSheet({
  grantedOnRequest = false,
  grantedOnRefresh = false,
}: {
  grantedOnRequest?: boolean;
  grantedOnRefresh?: boolean;
} = {}) {
  const requestPermission = jest.fn(async () => ({ granted: grantedOnRequest }));
  const refreshPermission = jest.fn(async () => ({ granted: grantedOnRefresh }));
  const onGranted = jest.fn();
  const onClose = jest.fn();
  render(
    <LocaleProvider>
      <CameraPermissionSheet
        requestPermission={requestPermission}
        refreshPermission={refreshPermission}
        onGranted={onGranted}
        onClose={onClose}
      />
    </LocaleProvider>,
  );
  return { requestPermission, refreshPermission, onGranted, onClose };
}

function action(label: string): MockAction {
  const found = mockDialogProps?.actions?.find((candidate) => candidate.label === label);
  if (!found) throw new Error(`Missing dialog action: ${label}`);
  return found;
}

describe('CameraPermissionSheet', () => {
  let appStateListener: ((state: 'active' | 'background') => void) | null;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDialogProps = null;
    mockDialogControl = null;
    appStateListener = null;
    Platform.OS = 'android';
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      appStateListener = listener as (state: 'active' | 'background') => void;
      return { remove: jest.fn() };
    });
  });

  it('uses Bloom detached Dialog presentation and its declarative actions', () => {
    renderSheet();

    expect(mockDialogControl?.open).toHaveBeenCalledTimes(1);
    expect(mockDialogProps?.title).toBe('Camera access needed');
    expect(mockDialogProps?.description).toBe('Allow camera access to scan sign-in QR codes.');
    expect(mockDialogProps?.actions?.map(({ label }) => label)).toEqual([
      'Allow camera',
      'Open settings',
      'Cancel',
    ]);
    expect(action('Cancel').color).toBe('cancel');
  });

  it('keeps the sheet open while asking, then closes before opening the scanner', async () => {
    const { requestPermission, onGranted } = renderSheet({ grantedOnRequest: true });

    action('Allow camera').onPress?.();

    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockDialogControl?.close).toHaveBeenCalledTimes(1));
    expect(action('Allow camera').shouldCloseOnPress).toBe(false);

    const afterClose = mockDialogControl?.close.mock.calls[0]?.[0] as (() => void) | undefined;
    expect(onGranted).not.toHaveBeenCalled();
    afterClose?.();
    expect(onGranted).toHaveBeenCalledTimes(1);
  });

  it('refreshes permission after settings and follows the same close lifecycle', async () => {
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    const { refreshPermission } = renderSheet({ grantedOnRefresh: true });

    action('Open settings').onPress?.();
    expect(openSettings).toHaveBeenCalledTimes(1);

    await act(async () => {
      appStateListener?.('background');
      appStateListener?.('active');
    });

    await waitFor(() => expect(refreshPermission).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockDialogControl?.close).toHaveBeenCalledTimes(1));
  });
});
