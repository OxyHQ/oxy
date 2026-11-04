import { surfaces } from '@oxy.so/bloom/surfaces';
import { presentDetached } from '../surfaces';

jest.mock('../../components/SurfaceScreen', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../routes', () => ({
  screensReady: () => false,
  loadScreens: () => new Promise<void>(() => {}),
}));

it('presents the account surface immediately even when its screens are not loaded', () => {
  jest.mocked(surfaces.present).mockClear();
  const instance = presentDetached('AccountDialog');
  expect(surfaces.present).toHaveBeenCalledTimes(1);
  instance.dismiss();
});
