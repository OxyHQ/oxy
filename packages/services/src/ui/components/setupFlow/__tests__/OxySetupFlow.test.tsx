/**
 * `OxySetupFlow` — a platform's setup in the sign-in's own frame (ADR 0064).
 *
 * The flow is controlled and presentational, so these render it with plain
 * steps and assert what it draws and owes: the step's header and footer, Back
 * only with `onBack`, the primary's disabled and busy states, the quiet
 * progress, and on a step change the focus move and the polite announcement
 * (the web's live region; native's announcement API). `oxySignInStep` is the
 * SDK's chooser unchanged, here a stub that asks for the split card's width as
 * the real one does: the flow must hand that width to the host and give it back.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AccessibilityInfo, Platform } from 'react-native';
import { OxySetupFlow, type OxySetupFlowProps, type OxySetupStep } from '../OxySetupFlow';
import { oxySignInStep } from '../oxySignInStep';

let mockReducedMotion = false;
jest.mock('@oxy.so/bloom/hooks', () => ({
  ...jest.requireActual('@oxy.so/bloom/hooks'),
  usePrefersReducedMotion: () => mockReducedMotion,
}));

// The SDK's chooser, as far as the flow can tell: on its split card (the QR
// side, from `md`) it asks its surface for 880 while mounted.
jest.mock('../../OxyAuthChooser', () => {
  const { useSurfaceFrameWidth } = jest.requireActual('../../../hooks/useSurfaceFrameWidth');
  return {
    __esModule: true,
    default: () => {
      useSurfaceFrameWidth(880);
      return 'The SDK sign-in';
    },
  };
});

const welcome: OxySetupStep = {
  id: 'welcome',
  title: 'Welcome',
  description: 'Set up your computer with your Oxy account.',
  content: null,
  primary: { label: 'Continue', onPress: () => undefined },
};

const pin = (overrides: Partial<OxySetupStep> = {}): OxySetupStep => ({
  id: 'pin',
  title: 'Create a PIN',
  description: 'You will use it to unlock this computer.',
  content: <input aria-label="PIN" />,
  primary: { label: 'Continue', onPress: () => undefined },
  ...overrides,
});

const appearance: OxySetupStep = {
  id: 'appearance',
  title: 'Choose your look',
  content: null,
  primary: { label: 'Continue', onPress: () => undefined },
  secondary: { label: 'Set Up Later', onPress: () => undefined },
};

const STEPS: OxySetupStep[] = [welcome, oxySignInStep(), pin(), appearance];

const flow = (props: Partial<OxySetupFlowProps> = {}) => (
  <OxySetupFlow label="Set up your account" steps={STEPS} current="welcome" {...props} />
);

const originalOS = Platform.OS;

afterEach(() => {
  Platform.OS = originalOS;
  mockReducedMotion = false;
  jest.restoreAllMocks();
});

describe('a step', () => {
  it('draws its header in the sign-in frame, its icon in place of the mark, and its content', () => {
    render(
      flow({
        steps: [pin({ icon: <span data-testid="pin-icon" /> }), appearance],
        current: 'pin',
      }),
    );
    expect(screen.getByLabelText('Set up your account')).toBeTruthy();
    expect(screen.getByText('Create a PIN')).toBeTruthy();
    expect(screen.getByText('You will use it to unlock this computer.')).toBeTruthy();
    expect(screen.getByTestId('pin-icon')).toBeTruthy();
    expect(screen.getByLabelText('PIN')).toBeTruthy();
  });

  it('draws a step with an aside as the split card and asks its surface for 880', () => {
    const onMaxWidthChange = jest.fn();
    const { rerender } = render(
      flow({
        steps: [welcome, pin({ aside: <span data-testid="pin-aside" /> })],
        current: 'pin',
        onMaxWidthChange,
      }),
    );
    expect(screen.getByTestId('pin-aside')).toBeTruthy();
    expect(onMaxWidthChange).toHaveBeenLastCalledWith(880);

    rerender(
      flow({
        steps: [welcome, pin({ aside: <span data-testid="pin-aside" /> })],
        current: 'welcome',
        onMaxWidthChange,
      }),
    );
    expect(onMaxWidthChange).toHaveBeenLastCalledWith(null);
  });

  it('renders nothing for a current id that is not one of its steps', () => {
    const { container } = render(flow({ current: 'nowhere' }));
    expect(container.textContent).toBe('');
  });
});

describe('the footer', () => {
  it('offers Back only when onBack is given, in the SDK’s own words by default', () => {
    const { rerender } = render(flow({ current: 'pin' }));
    expect(screen.queryByTestId('oxy-setup-back')).toBeNull();

    const onBack = jest.fn();
    rerender(flow({ current: 'pin', onBack }));
    fireEvent.click(screen.getByText('Back'));
    expect(onBack).toHaveBeenCalledTimes(1);

    rerender(flow({ current: 'pin', onBack, backLabel: 'Previous' }));
    expect(screen.getByTestId('oxy-setup-back').textContent).toBe('Previous');
  });

  it('draws Back, then the secondary and the primary, in that order', () => {
    render(flow({ current: 'appearance', onBack: () => undefined }));
    const order = screen
      .getAllByRole('button')
      .map((button) => button.getAttribute('data-testid'))
      .filter((id) => id?.startsWith('oxy-setup-'));
    expect(order).toEqual(['oxy-setup-back', 'oxy-setup-secondary', 'oxy-setup-primary']);
  });

  it('presses the primary and the secondary', () => {
    const onPrimary = jest.fn();
    const onSecondary = jest.fn();
    render(
      flow({
        steps: [
          {
            ...appearance,
            primary: { label: 'Continue', onPress: onPrimary, testID: 'look-continue' },
            secondary: { label: 'Set Up Later', onPress: onSecondary },
          },
        ],
        current: 'appearance',
      }),
    );
    fireEvent.click(screen.getByTestId('look-continue'));
    fireEvent.click(screen.getByText('Set Up Later'));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(onSecondary).toHaveBeenCalledTimes(1);
  });

  it('refuses a disabled primary', () => {
    const onPress = jest.fn();
    render(
      flow({
        steps: [pin({ primary: { label: 'Continue', onPress, disabled: true } })],
        current: 'pin',
      }),
    );
    const primary = screen.getByTestId('oxy-setup-primary') as HTMLButtonElement;
    expect(primary.disabled).toBe(true);
    fireEvent.click(primary);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('says a busy primary is busy, and holds Back and the secondary while it works', () => {
    render(
      flow({
        steps: [
          {
            ...appearance,
            primary: { label: 'Continue', onPress: () => undefined, busy: true },
          },
        ],
        current: 'appearance',
        onBack: () => undefined,
      }),
    );
    const primary = screen.getByTestId('oxy-setup-primary');
    expect(primary.getAttribute('aria-busy')).toBe('true');
    expect((screen.getByTestId('oxy-setup-back') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('oxy-setup-secondary') as HTMLButtonElement).disabled).toBe(true);
  });

  it('draws no footer for a step without actions and no Back', () => {
    render(flow({ current: 'oxy-sign-in' }));
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('progress', () => {
  it('says "Step N of M" under decorative dots hidden from assistive technology', () => {
    render(flow({ current: 'pin' }));
    expect(screen.getByTestId('oxy-setup-progress').textContent).toBe('Step 3 of 4');
    const dots = screen.getByTestId('oxy-setup-dots');
    expect(dots.getAttribute('aria-hidden')).toBe('true');
    expect(dots.getAttribute('data-index')).toBe('2');
    expect(dots.getAttribute('data-count')).toBe('4');
  });

  it('is left out with showProgress false', () => {
    render(flow({ current: 'pin', showProgress: false }));
    expect(screen.queryByTestId('oxy-setup-progress')).toBeNull();
    expect(screen.queryByTestId('oxy-setup-dots')).toBeNull();
  });
});

describe('a step change', () => {
  it('moves focus to the new title and says the step politely; appearing says nothing', () => {
    const { rerender } = render(flow({ current: 'welcome' }));
    const live = screen.getByTestId('oxy-setup-announcement');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe('');
    expect(document.activeElement).toBe(document.body);

    rerender(flow({ current: 'appearance' }));
    expect(document.activeElement).toBe(screen.getByText('Choose your look'));
    expect(live.textContent).toBe('Choose your look, step 4 of 4');
  });

  it('leaves focus to a step whose content takes it', () => {
    const { rerender } = render(
      flow({ steps: [welcome, pin({ initialFocus: 'content' })], current: 'welcome' }),
    );
    rerender(flow({ steps: [welcome, pin({ initialFocus: 'content' })], current: 'pin' }));
    expect(document.activeElement).not.toBe(screen.getByText('Create a PIN'));
    expect(screen.getByTestId('oxy-setup-announcement').textContent).toBe(
      'Create a PIN, step 2 of 2',
    );
  });

  it('says only where an untitled step sits (the SDK sign-in brings its own heading)', () => {
    const { rerender } = render(flow({ current: 'welcome' }));
    rerender(flow({ current: 'oxy-sign-in' }));
    expect(screen.getByTestId('oxy-setup-announcement').textContent).toBe('Step 2 of 4');
  });

  it('announces through the platform on native, once per change', () => {
    Platform.OS = 'android';
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => undefined);
    const { rerender } = render(flow({ current: 'welcome' }));
    expect(announce).not.toHaveBeenCalled();
    expect(screen.queryByTestId('oxy-setup-announcement')).toBeNull();

    rerender(flow({ current: 'pin' }));
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Create a PIN, step 3 of 4');
  });

  it('queues the announcement on iOS, after the title the focus move reads', () => {
    Platform.OS = 'ios';
    const queued = jest.fn();
    Object.assign(AccessibilityInfo, { announceForAccessibilityWithOptions: queued });
    const { rerender } = render(flow({ current: 'welcome' }));
    rerender(flow({ current: 'pin' }));
    expect(queued).toHaveBeenCalledWith('Create a PIN, step 3 of 4', { queue: true });
  });

  it('travels forward to a later step and backward to an earlier one', () => {
    const { rerender } = render(flow({ current: 'welcome' }));
    rerender(flow({ current: 'pin' }));
    expect(screen.getByTestId('screen-transition').getAttribute('data-direction')).toBe('forward');
    rerender(flow({ current: 'oxy-sign-in' }));
    expect(screen.getByTestId('screen-transition').getAttribute('data-direction')).toBe('backward');
  });

  it('does not move under reduced motion', () => {
    mockReducedMotion = true;
    const { rerender } = render(flow({ current: 'welcome' }));
    rerender(flow({ current: 'pin' }));
    expect(screen.queryByTestId('screen-transition')).toBeNull();
    expect(screen.getByTestId('oxy-setup-step')).toBeTruthy();
    expect(screen.getByText('Create a PIN')).toBeTruthy();
  });
});

describe('oxySignInStep', () => {
  it('is the SDK chooser, untitled, leaving focus to its own screens', () => {
    const step = oxySignInStep();
    expect(step.id).toBe('oxy-sign-in');
    expect(step.title).toBeUndefined();
    expect(step.initialFocus).toBe('content');
    expect(oxySignInStep({ id: 'account' }).id).toBe('account');
  });

  it('hands the chooser’s split-card width to the host, and gives it back after', () => {
    const onMaxWidthChange = jest.fn();
    const { rerender } = render(flow({ current: 'welcome', onMaxWidthChange }));
    expect(onMaxWidthChange).toHaveBeenLastCalledWith(null);

    rerender(flow({ current: 'oxy-sign-in', onMaxWidthChange }));
    expect(screen.getByText('The SDK sign-in')).toBeTruthy();
    expect(onMaxWidthChange).toHaveBeenLastCalledWith(880);

    act(() => {
      rerender(flow({ current: 'pin', onMaxWidthChange }));
    });
    expect(onMaxWidthChange).toHaveBeenLastCalledWith(null);
  });
});
