/**
 * `FILE_IMAGE_EAGER_VARIANTS` (`eagerImageVariantTypes`): which ladder rungs an
 * image upload renders eagerly. Unset is the whole ladder (today's behaviour);
 * a list narrows it, and a rung left out renders on its first request; a name
 * not on the ladder is never a reason to render less.
 */

const mockError = jest.fn();
jest.mock('../../utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: (...args: unknown[]) => mockError(...args),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

import { IMAGE_VARIANTS } from '@oxy.so/utils/image';
import { eagerImageVariantTypes } from '../variantService';

const LADDER = Object.keys(IMAGE_VARIANTS).sort();

describe('eagerImageVariantTypes', () => {
  beforeEach(() => mockError.mockClear());

  it('is the whole ladder when unset or empty', () => {
    expect([...eagerImageVariantTypes(undefined)].sort()).toEqual(LADDER);
    expect([...eagerImageVariantTypes('')].sort()).toEqual(LADDER);
    expect([...eagerImageVariantTypes(' , ')].sort()).toEqual(LADDER);
  });

  it('narrows to the rungs named', () => {
    expect([...eagerImageVariantTypes('thumb, w320,w640 ,w1280')].sort()).toEqual(
      ['thumb', 'w1280', 'w320', 'w640'].sort(),
    );
    expect(mockError).not.toHaveBeenCalled();
  });

  it('falls back to the whole ladder, loudly, on a name not on it', () => {
    expect([...eagerImageVariantTypes('thumb,w4096')].sort()).toEqual(LADDER);
    expect(mockError).toHaveBeenCalledTimes(1);
  });
});
