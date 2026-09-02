import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { UsernameStep } from '../../components/auth/UsernameStep';

const mockDialogOpen = jest.fn();
let mockDialogActions: { label: string; color?: string }[] | undefined;

jest.mock('lottie-react-native', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: ReactModule.forwardRef(function MockLottie(
      _props: unknown,
      ref: React.ForwardedRef<{ play: () => void; reset: () => void }>
    ) {
      ReactModule.useImperativeHandle(ref, () => ({
        play: jest.fn(),
        reset: jest.fn(),
      }));
      return ReactModule.createElement('div', { 'data-testid': 'lottie' });
    }),
  };
});

jest.mock('@oxyhq/bloom/dialog', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  return {
    useDialogControl: () => ({
      open: mockDialogOpen,
      close: jest.fn(),
      ref: { current: null },
    }),
    Dialog: ({
      children,
      actions,
    }: {
      children?: React.ReactNode;
      actions?: { label: string; color?: string }[];
    }) => {
      mockDialogActions = actions;
      return ReactModule.createElement('div', null, children);
    },
  };
});

jest.mock('@/components/ui', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  return {
    Button: ({
      children,
      onPress,
      disabled,
    }: {
      children?: React.ReactNode;
      onPress?: () => void;
      disabled?: boolean;
    }) =>
      ReactModule.createElement(
        'button',
        { type: 'button', onClick: onPress, disabled },
        children
      ),
    KeyboardAwareScrollViewWrapper: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement('div', null, children),
  };
});

jest.mock('@/hooks/useColors', () => ({
  useColors: () => ({
    card: '#fff',
    border: '#ccc',
    error: '#f00',
    success: '#0a0',
    textSecondary: '#666',
    text: '#000',
  }),
}));

jest.mock('@/hooks/auth/useUsernameValidation', () => ({
  useUsernameValidation: () => ({
    isValid: true,
    isAvailable: true,
    isChecking: false,
    error: null,
  }),
}));

jest.mock('@/lib/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function renderStep(onContinue: () => void | Promise<void>) {
  return render(
    <UsernameStep
      username="woodenpills"
      onUsernameChange={jest.fn()}
      onContinue={onContinue}
      isOffline={false}
      oxyServices={null}
      backgroundColor="#fff"
      textColor="#000"
    />
  );
}

describe('UsernameStep', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockDialogOpen.mockClear();
    mockDialogActions = undefined;
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('releases confirmation when the parent remains on the screen', async () => {
    const onContinue = jest.fn().mockResolvedValue(undefined);
    renderStep(onContinue);

    fireEvent.click(screen.getByText('auth.usernameStep.confirm'));
    expect(screen.getByText('auth.usernameStep.confirming')).toBeTruthy();

    await act(async () => {
      jest.advanceTimersByTime(4000);
      await Promise.resolve();
    });

    expect(onContinue).toHaveBeenCalledTimes(1);
    const confirmButton = screen
      .getByText('auth.usernameStep.confirm')
      .closest('button');
    expect(confirmButton?.disabled).toBe(false);
  });

  it('opens the username explainer on every press', () => {
    renderStep(jest.fn());
    const learnMore = screen.getByText('auth.usernameStep.learnMore');

    fireEvent.click(learnMore);
    fireEvent.click(learnMore);

    expect(mockDialogOpen).toHaveBeenCalledTimes(2);
  });

  it('uses the Bloom Dialog action for the username explainer close button', () => {
    renderStep(jest.fn());

    expect(mockDialogActions).toEqual([
      { label: 'common.close', color: 'cancel' },
    ]);
  });

  it('cancels delayed confirmation after unmount', () => {
    const onContinue = jest.fn();
    const view = renderStep(onContinue);

    fireEvent.click(screen.getByText('auth.usernameStep.confirm'));
    view.unmount();
    act(() => jest.advanceTimersByTime(4000));

    expect(onContinue).not.toHaveBeenCalled();
  });
});
