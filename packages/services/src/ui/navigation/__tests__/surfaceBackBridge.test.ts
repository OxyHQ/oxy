const listeners = new Set<() => boolean>();

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  BackHandler: {
    addEventListener: (_event: string, listener: () => boolean) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  },
}));

import { __resetSurfaceBackBridgeForTests, pushSurfaceBackHandler } from '../surfaceBackBridge';

const press = () => [...listeners].some((listener) => listener());

afterEach(() => __resetSurfaceBackBridgeForTests());

it('holds Android Back only while a surface is open', () => {
  expect(listeners.size).toBe(0);
  const close = jest.fn(() => true);
  const unregister = pushSurfaceBackHandler(close);
  expect(listeners.size).toBe(1);
  expect(press()).toBe(true);
  expect(close).toHaveBeenCalledTimes(1);
  unregister();
  expect(listeners.size).toBe(0);
});

it('routes Back to the topmost surface and keeps one listener for a stack', () => {
  const lower = jest.fn(() => true);
  const upper = jest.fn(() => true);
  const releaseLower = pushSurfaceBackHandler(lower);
  const releaseUpper = pushSurfaceBackHandler(upper);
  expect(listeners.size).toBe(1);
  press();
  expect(upper).toHaveBeenCalledTimes(1);
  expect(lower).not.toHaveBeenCalled();
  releaseUpper();
  press();
  expect(lower).toHaveBeenCalledTimes(1);
  releaseLower();
  expect(listeners.size).toBe(0);
});
