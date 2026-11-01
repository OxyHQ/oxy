import { getScreenComponent, loadScreens, screensReady } from '../routes';

const mockAccountScreen = () => null;
jest.mock('../screenComponents', () => ({
  screenComponents: { AccountDialog: mockAccountScreen },
}));

it('shares one screen load between simultaneous surface requests', async () => {
  expect(screensReady()).toBe(false);
  const first = loadScreens();
  const second = loadScreens();
  expect(first).toBe(second);
  await Promise.all([first, second]);
  expect(screensReady()).toBe(true);
  expect(getScreenComponent('AccountDialog')).toBe(mockAccountScreen);
});
