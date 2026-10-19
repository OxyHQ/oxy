/**
 * Both forks of `getImageSize` keep react-native's `Image.getSize` contract —
 * the PIXEL size on success, a rejection when the image cannot load — so the
 * grid, the viewer and the crop stage size their boxes the same on every
 * platform.
 */
const loadAsync = jest.fn();
jest.mock('expo-image', () => ({ Image: { loadAsync } }), { virtual: true });

const getSize = jest.fn();
jest.mock('react-native', () => ({ Image: { getSize } }));

import { getImageSize as getNativeImageSize } from '../imageSize.native';
import { getImageSize as getWebImageSize } from '../imageSize';

beforeEach(() => {
  loadAsync.mockReset();
  getSize.mockReset();
});

describe('getImageSize (native: expo-image)', () => {
  it('reports pixels and releases the decoded image', async () => {
    const release = jest.fn();
    loadAsync.mockResolvedValue({ width: 200, height: 150, scale: 2, release });

    await expect(getNativeImageSize('https://cdn.example/a.gif')).resolves.toEqual({
      width: 400,
      height: 300,
    });
    expect(loadAsync).toHaveBeenCalledWith('https://cdn.example/a.gif');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('treats a missing scale as 1', async () => {
    loadAsync.mockResolvedValue({ width: 64, height: 32, scale: 0, release: jest.fn() });
    await expect(getNativeImageSize('file:///a.webp')).resolves.toEqual({ width: 64, height: 32 });
  });

  it('rejects when the image cannot load', async () => {
    loadAsync.mockRejectedValue(new Error('decode failed'));
    await expect(getNativeImageSize('https://cdn.example/broken')).rejects.toThrow('decode failed');
  });
});

describe('getImageSize (web: react-native-web getSize)', () => {
  it('resolves what getSize reports', async () => {
    getSize.mockImplementation((_uri: string, ok: (w: number, h: number) => void) => ok(640, 480));
    await expect(getWebImageSize('https://cdn.example/a.png')).resolves.toEqual({
      width: 640,
      height: 480,
    });
  });

  it('rejects through the failure callback', async () => {
    const failure = new Error('404');
    getSize.mockImplementation((_uri: string, _ok: unknown, fail: (error: unknown) => void) =>
      fail(failure),
    );
    await expect(getWebImageSize('https://cdn.example/missing')).rejects.toBe(failure);
  });
});
