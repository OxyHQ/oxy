/**
 * `resolveDeliveryPlatform` — the consumer-side classification `@oxy.so/core`
 * refuses to do itself.
 *
 * The verdict decides one thing: whether automatic delivery may take the
 * same-device Commons deep link. A wrong `'mobile'` strands the user on a
 * custom-scheme navigation that never resolves, so every ambiguous signal must
 * resolve AWAY from `'mobile'`.
 */

const isWebBrowserMock = jest.fn(() => true);
jest.mock('../../src/ui/utils/isWebBrowser', () => ({
  __esModule: true,
  isWebBrowser: () => isWebBrowserMock(),
}));

// eslint-disable-next-line import/first
import { resolveDeliveryPlatform } from '../../src/ui/utils/deliveryPlatform';

/** Install a `navigator.userAgentData.mobile` bit, or remove it entirely. */
const setUserAgentData = (mobile: boolean | undefined): void => {
  if (mobile === undefined) {
    Reflect.deleteProperty(navigator, 'userAgentData');
    return;
  }
  Object.defineProperty(navigator, 'userAgentData', {
    value: { mobile },
    configurable: true,
  });
};

/** Install `maxTouchPoints` (jsdom reports 0 and does not let it be assigned). */
const setMaxTouchPoints = (points: number): void => {
  Object.defineProperty(navigator, 'maxTouchPoints', { value: points, configurable: true });
};

/** Install a `matchMedia` reporting the given primary-pointer coarseness. */
const setPrimaryPointerCoarse = (coarse: boolean | undefined): void => {
  if (coarse === undefined) {
    Reflect.deleteProperty(window, 'matchMedia');
    return;
  }
  Object.defineProperty(window, 'matchMedia', {
    value: (query: string) => ({ matches: query.includes('coarse') ? coarse : !coarse }),
    configurable: true,
  });
};

describe('resolveDeliveryPlatform', () => {
  beforeEach(() => {
    isWebBrowserMock.mockReturnValue(true);
    setUserAgentData(undefined);
    setPrimaryPointerCoarse(undefined);
    setMaxTouchPoints(0);
  });

  afterAll(() => {
    setUserAgentData(undefined);
    setPrimaryPointerCoarse(undefined);
    setMaxTouchPoints(0);
  });

  it('classifies native as mobile — an Oxy app on the device Commons lives on', () => {
    isWebBrowserMock.mockReturnValue(false);
    expect(resolveDeliveryPlatform()).toBe('mobile');
  });

  it('believes the User-Agent Client Hints bit in both directions', () => {
    setUserAgentData(true);
    expect(resolveDeliveryPlatform()).toBe('mobile');

    setUserAgentData(false);
    // Even with a touchscreen attached, the hint wins.
    setPrimaryPointerCoarse(true);
    setMaxTouchPoints(10);
    expect(resolveDeliveryPlatform()).toBe('desktop');
  });

  it('falls back to a coarse PRIMARY pointer plus a touch digitizer', () => {
    setPrimaryPointerCoarse(true);
    setMaxTouchPoints(5);
    expect(resolveDeliveryPlatform()).toBe('mobile');
  });

  it('does not misclassify a touchscreen laptop (mouse is the primary pointer)', () => {
    setPrimaryPointerCoarse(false);
    setMaxTouchPoints(10);
    expect(resolveDeliveryPlatform()).toBe('desktop');
  });

  it('does not misclassify a coarse-pointer surface with no touch digitizer', () => {
    setPrimaryPointerCoarse(true);
    setMaxTouchPoints(0);
    expect(resolveDeliveryPlatform()).toBe('desktop');
  });

  it('reports unknown when neither signal exists, rather than guessing mobile', () => {
    expect(resolveDeliveryPlatform()).toBe('unknown');
  });
});
