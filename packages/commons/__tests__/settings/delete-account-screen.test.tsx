/**
 * Commons "Delete account" layout (OxyHQ/oxy#1375 item 24).
 *
 * - The title sat under the status bar: the Settings stack renders no
 *   navigator header, and the screen's scroller added no top inset.
 * - With the keyboard open, "Delete my account" was hidden behind it: the
 *   scroller only kept the caret above the keyboard, not the buttons under
 *   the input.
 *
 * The screen now asks its scroller for the top inset and passes the measured
 * height of everything under the input as `bottomOffset`, the same pattern as
 * the username step.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';

const BELOW_INPUT_HEIGHT = 140;
const mockScrollViewProps: { reserveTopInset?: boolean; bottomOffset?: number }[] = [];

// The shared View stub drops `onLayout`; this one reports a measured height for
// the block under the input, the way the native layout pass would.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  return {
    ...actual,
    View: (props: {
      testID?: string;
      onLayout?: (event: { nativeEvent: { layout: { x: number; y: number; width: number; height: number } } }) => void;
    }) => {
      const { onLayout, testID } = props;
      ReactModule.useEffect(() => {
        if (testID === 'delete-account-below-input') {
          onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: BELOW_INPUT_HEIGHT } } });
        }
      }, [onLayout, testID]);
      return actual.View(props);
    },
  };
});

jest.mock('@/components/ui', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const Box = ({ children }: { children?: React.ReactNode }) => R.createElement('div', null, children);
  return {
    ImportantBanner: Box,
    Section: Box,
    StackHeader: ({ title }: { title: string }) => R.createElement('h1', null, title),
    KeyboardAwareScrollViewWrapper: ({
      children,
      reserveTopInset,
      bottomOffset,
    }: {
      children?: React.ReactNode;
      reserveTopInset?: boolean;
      bottomOffset?: number;
    }) => {
      mockScrollViewProps.push({ reserveTopInset, bottomOffset });
      return R.createElement('div', null, children);
    },
  };
});

jest.mock('@/constants/icons', () => ({ Icons: { closeCircle: () => null } }));
jest.mock('@/hooks/useColors', () => ({
  useColors: () => ({ background: '#fff', card: '#fff', border: '#ccc', error: '#f00', text: '#000', textSecondary: '#666' }),
}));
jest.mock('@/lib/i18n', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn(), replace: jest.fn() }) }));
jest.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: jest.fn() }) }));
jest.mock('@oxy.so/bloom/surfaces', () => ({ alert: jest.fn() }));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: { error: jest.fn() } }));
jest.mock('@oxy.so/core/crypto', () => ({ KeyManager: { hasIdentity: jest.fn(), deleteIdentity: jest.fn() } }));
jest.mock('@/lib/account/delete-account-flow', () => ({ runAccountDeletion: jest.fn() }));
jest.mock('@/lib/notifications/push-registration', () => ({ retireVaultPushToken: jest.fn() }));
jest.mock('@/hooks/useOnboardingStatus', () => ({
  ONBOARDING_IDENTITY_QUERY_KEY: ['identity'],
  ONBOARDING_COMPLETE_QUERY_KEY: ['complete'],
  ONBOARDING_FLOW_QUERY_KEY: ['flow'],
}));
jest.mock('@/hooks/identity/identityStore', () => ({
  persistOnboardingComplete: jest.fn(),
  persistOnboardingFlow: jest.fn(),
}));

import { __setOxyState } from '@oxy.so/services';
import DeleteAccountScreen from '@/app/(tabs)/(settings)/delete-account';

describe('Delete account screen layout', () => {
  beforeEach(() => {
    mockScrollViewProps.length = 0;
    __setOxyState({ user: { id: 'u1', username: 'qatest0925' }, isLoading: false });
  });

  it('keeps the title below the status bar', () => {
    render(<DeleteAccountScreen />);
    expect(screen.getByText('data.deleteAccount.title')).toBeTruthy();
    expect(mockScrollViewProps[mockScrollViewProps.length - 1]?.reserveTopInset).toBe(true);
  });

  it('keeps "Delete my account" above the keyboard while typing the username', () => {
    render(<DeleteAccountScreen />);

    const latest = mockScrollViewProps[mockScrollViewProps.length - 1];
    expect(latest?.bottomOffset).toBeGreaterThanOrEqual(BELOW_INPUT_HEIGHT);

    // The measured block is the one holding both buttons, so the offset
    // covers the Delete button rather than only the caret.
    const block = screen.getByTestId('delete-account-below-input');
    expect(block.textContent).toContain('data.deleteAccount.deleteCta');
    expect(block.textContent).toContain('data.deleteAccount.cancel');
  });
});
