import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { SurfaceControls } from '@oxy.so/bloom/surfaces';
import SurfaceScreen, {
  type SurfaceNavigationActions,
} from '../../src/ui/components/SurfaceScreen';
import { createSurfaceNavStack } from '../../src/ui/navigation/surfaceNavStack';
import { __invokeTopSurfaceBackForTests } from '../../src/ui/navigation/surfaceBackBridge';

const mockLoadScreens = jest.fn<Promise<void>, []>();
let mockReady = false;
jest.mock('@oxy.so/bloom/dialog', () => ({
  ...jest.requireActual('../__mocks__/bloom'),
  useDialogFrame: jest.fn(),
  useDialogHeader: jest.fn(),
}));
jest.mock('../../src/ui/navigation/routes', () => ({
  screensReady: () => mockReady,
  loadScreens: () => mockLoadScreens(),
  getScreenComponent: (route: string) => () => <div>{route}</div>,
}));
jest.mock('../../src/ui/navigation/surfaceRegistry', () => ({
  getSurfaceConfig: () => ({ header: true, morph: true }),
}));
jest.mock('../../src/ui/hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const navigation: SurfaceNavigationActions = {
  closeAllRouteSurfaces: jest.fn(),
  navigateWithinOrPresent: jest.fn(),
  replaceWithinOrPresent: jest.fn(),
  presentRoute: jest.fn(),
};

beforeEach(() => {
  mockReady = false;
  mockLoadScreens.mockReset();
});

it('shows a loading surface immediately and opens the latest route when screens arrive', async () => {
  const completions: Array<() => void> = [];
  mockLoadScreens.mockImplementation(
    () => new Promise<void>((resolve) => completions.push(resolve)),
  );
  const stack = createSurfaceNavStack('AccountDialog');
  const dismiss = jest.fn();
  render(
    <SurfaceScreen
      navStack={stack}
      navigation={navigation}
      surface={{ dismiss } as unknown as SurfaceControls}
    />,
  );
  expect(screen.getByText('loading')).toBeTruthy();
  expect(screen.queryByText('AccountDialog')).toBeNull();
  act(() => stack.navigate('ManageAccount'));
  await act(async () => completions[0]?.());
  expect(screen.getByText('ManageAccount')).toBeTruthy();
  expect(dismiss).not.toHaveBeenCalled();
});

it('offers a retry when loading fails and renders the screen after it succeeds', async () => {
  mockLoadScreens.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce();
  const stack = createSurfaceNavStack('AccountDialog');
  render(
    <SurfaceScreen
      navStack={stack}
      navigation={navigation}
      surface={{ dismiss: jest.fn() } as unknown as SurfaceControls}
    />,
  );
  const retry = await screen.findByText('common.actions.tryAgain');
  fireEvent.click(retry);
  expect(await screen.findByText('AccountDialog')).toBeTruthy();
  expect(mockLoadScreens).toHaveBeenCalledTimes(2);
});

it('uses screens registered by another entry while the load was pending', async () => {
  const failures: Array<(error: Error) => void> = [];
  mockLoadScreens.mockImplementation(
    () => new Promise<void>((_resolve, reject) => failures.push(reject)),
  );
  const stack = createSurfaceNavStack('AccountDialog');
  render(
    <SurfaceScreen
      navStack={stack}
      navigation={navigation}
      surface={{ dismiss: jest.fn() } as unknown as SurfaceControls}
    />,
  );
  mockReady = true;
  await act(async () => failures[0]?.(new Error('offline')));
  expect(screen.getByText('AccountDialog')).toBeTruthy();
  expect(screen.queryByText('common.actions.tryAgain')).toBeNull();
});

it('dismisses while loading and ignores a late completion after unmount, including StrictMode', async () => {
  const completions: Array<() => void> = [];
  mockLoadScreens.mockImplementation(
    () => new Promise<void>((resolve) => completions.push(resolve)),
  );
  const stack = createSurfaceNavStack('AccountDialog');
  const dismiss = jest.fn();
  const view = render(
    <StrictMode>
      <SurfaceScreen
        navStack={stack}
        navigation={navigation}
        surface={{ dismiss } as unknown as SurfaceControls}
      />
    </StrictMode>,
  );
  act(() => stack.requestDismiss());
  expect(dismiss).toHaveBeenCalledTimes(1);
  view.unmount();
  await act(async () => {
    for (const complete of completions) complete();
  });
  expect(dismiss).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('AccountDialog')).toBeNull();
});

it('does not start loading when dismissed before the host mounts', () => {
  const stack = createSurfaceNavStack('AccountDialog');
  const dismiss = jest.fn();
  stack.requestDismiss();
  render(
    <SurfaceScreen
      navStack={stack}
      navigation={navigation}
      surface={{ dismiss } as unknown as SurfaceControls}
    />,
  );
  expect(dismiss).toHaveBeenCalledTimes(1);
  expect(mockLoadScreens).not.toHaveBeenCalled();
});

it('handles system back while the screen code is still loading', () => {
  mockLoadScreens.mockImplementation(() => new Promise<void>(() => {}));
  const stack = createSurfaceNavStack('AccountDialog');
  const dismiss = jest.fn();
  render(
    <SurfaceScreen
      navStack={stack}
      navigation={navigation}
      surface={{ dismiss } as unknown as SurfaceControls}
    />,
  );
  act(() => __invokeTopSurfaceBackForTests());
  expect(dismiss).toHaveBeenCalledTimes(1);
});

it('respects a surface that cannot be dismissed by system back while loading', () => {
  mockLoadScreens.mockImplementation(() => new Promise<void>(() => {}));
  const stack = createSurfaceNavStack('AvatarCrop');
  const dismiss = jest.fn();
  render(
    <SurfaceScreen
      navStack={stack}
      navigation={navigation}
      dismissOnBackdrop={false}
      surface={{ dismiss } as unknown as SurfaceControls}
    />,
  );
  act(() => __invokeTopSurfaceBackForTests());
  expect(dismiss).not.toHaveBeenCalled();
  expect(stack.store.getState().closing).toBe(false);
});

it('renders an already registered screen without requesting it again', () => {
  mockReady = true;
  const stack = createSurfaceNavStack('AccountDialog');
  render(
    <SurfaceScreen
      navStack={stack}
      navigation={navigation}
      surface={{ dismiss: jest.fn() } as unknown as SurfaceControls}
    />,
  );
  expect(screen.getByText('AccountDialog')).toBeTruthy();
  expect(mockLoadScreens).not.toHaveBeenCalled();
});
