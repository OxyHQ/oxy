import { isTopmostOverlayLayer } from '@oxy.so/bloom/overlay';
import { act, render } from '@testing-library/react';
import type { DialogHeaderConfig } from '@oxy.so/bloom/dialog';
import type { SurfaceControls } from '@oxy.so/bloom/surfaces';
import SurfaceScreen, {
  type SurfaceNavigationActions,
} from '../../src/ui/components/SurfaceScreen';
import { createSurfaceNavStack } from '../../src/ui/navigation/surfaceNavStack';
import type { BaseScreenProps } from '../../src/ui/types/navigation';
import { useSurfaceHeader } from '../../src/ui/hooks/useSurfaceHeader';
import { __invokeTopSurfaceBackForTests } from '../../src/ui/navigation/surfaceBackBridge';

let mockHeader: DialogHeaderConfig | null = null;
let mockHeaderMode = true;
let mockScreenProps: BaseScreenProps;
let mockLocalBack: (() => void) | undefined;
jest.mock('@oxy.so/bloom/dialog', () => ({
  ...jest.requireActual('../__mocks__/bloom'),
  useDialogFrame: jest.fn(),
  useDialogHeader: (header: DialogHeaderConfig | null) => {
    mockHeader = header;
  },
}));
jest.mock('../../src/ui/navigation/routes', () => ({
  getScreenComponent: () => MockScreen,
  screensReady: () => true,
  loadScreens: jest.fn(),
}));
jest.mock('../../src/ui/hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../../src/ui/navigation/surfaceRegistry', () => ({
  getSurfaceConfig: () => ({ header: mockHeaderMode, morph: true }),
}));
function MockScreen(props: BaseScreenProps) {
  mockScreenProps = props;
  useSurfaceHeader({ title: 'Screen', onBack: mockLocalBack });
  return null;
}
const navigation: SurfaceNavigationActions = {
  closeAllRouteSurfaces: jest.fn(),
  navigateWithinOrPresent: jest.fn(),
  replaceWithinOrPresent: jest.fn(),
  presentRoute: jest.fn(),
};

it('automatically adds Back for route history and removes it at the root without closing', () => {
  mockLocalBack = undefined;
  const stack = createSurfaceNavStack('AccountDialog');
  const dismiss = jest.fn();
  render(
    <SurfaceScreen
      navStack={stack}
      navigation={navigation}
      surface={{ dismiss } as unknown as SurfaceControls}
    />,
  );
  expect(mockHeader?.onBack).toBeUndefined();
  act(() => stack.navigate('ManageAccount'));
  expect(mockHeader?.onBack).toEqual(expect.any(Function));
  act(() => mockHeader?.onBack?.());
  expect(stack.getTop().route).toBe('AccountDialog');
  expect(mockHeader?.onBack).toBeUndefined();
  expect(dismiss).not.toHaveBeenCalled();
});

it('system back uses the same latest local-history callback as the visible header', () => {
  const first = jest.fn();
  const latest = jest.fn();
  mockLocalBack = first;
  const stack = createSurfaceNavStack('AccountDialog');
  const dismiss = jest.fn();
  const screen = render(
    <SurfaceScreen
      navStack={stack}
      navigation={navigation}
      surface={{ dismiss } as unknown as SurfaceControls}
    />,
  );
  mockLocalBack = latest;
  screen.rerender(
    <SurfaceScreen
      navStack={stack}
      navigation={navigation}
      surface={{ dismiss } as unknown as SurfaceControls}
    />,
  );
  act(() => __invokeTopSurfaceBackForTests());
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledTimes(1);
  expect(dismiss).not.toHaveBeenCalled();
});

it('backs through history even when a route owns its own header', () => {
  mockLocalBack = undefined;
  mockHeaderMode = false;
  const stack = createSurfaceNavStack('AccountDialog');
  stack.navigate('ManageAccount');
  const dismiss = jest.fn();
  render(
    <SurfaceScreen
      navStack={stack}
      navigation={navigation}
      surface={{ dismiss } as unknown as SurfaceControls}
    />,
  );
  expect(mockHeader).toBeNull();
  act(() => __invokeTopSurfaceBackForTests());
  expect(stack.getTop().route).toBe('AccountDialog');
  expect(dismiss).not.toHaveBeenCalled();
  mockHeaderMode = true;
});

it('explicit close dismisses the current host even when it is detached', () => {
  mockLocalBack = undefined;
  const stack = createSurfaceNavStack('AccountDialog');
  stack.navigate('ManageAccount');
  const dismiss = jest.fn();
  render(
    <SurfaceScreen
      navStack={stack}
      navigation={navigation}
      surface={{ dismiss } as unknown as SurfaceControls}
    />,
  );
  act(() => mockScreenProps.onClose?.());
  expect(dismiss).toHaveBeenCalledTimes(1);
  expect(stack.store.getState().closing).toBe(true);
});

it('leaves Escape to a sheet above the SDK dialog without changing its history', () => {
  mockLocalBack = undefined;
  const stack = createSurfaceNavStack('AccountDialog');
  stack.navigate('HelpSupport');
  const dismiss = jest.fn();
  render(
    <SurfaceScreen
      navStack={stack}
      navigation={navigation}
      surface={{ dismiss } as unknown as SurfaceControls}
    />,
  );
  jest.mocked(isTopmostOverlayLayer).mockReturnValue(false);
  const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
  window.dispatchEvent(escapeEvent);
  expect(escapeEvent.defaultPrevented).toBe(false);
  expect(stack.getTop().route).toBe('HelpSupport');
  expect(dismiss).not.toHaveBeenCalled();
  jest.mocked(isTopmostOverlayLayer).mockReturnValue(true);
});
