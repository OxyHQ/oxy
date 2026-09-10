/**
 * `useAvatarPicker` — the ONE write path for a profile picture.
 *
 * The hook no longer orchestrates picker→crop by hand: the whole
 * choose-and-crop experience is a single `ChangeAvatar` flow (opened via
 * `openWithinOrPresent`, which morphs into the caller's surface when one is open,
 * else presents cold) that resolves with the cropped JPEG, with a removal, or
 * `undefined`. These pin that contract, and that there is exactly ONE flow opened
 * (any second call would mean a second route to the cropper had crept back in).
 */

import { renderHook, act } from '@testing-library/react';

// Control what the SDK surface layer's openWithinOrPresent() resolves with.
const openWithinOrPresent = jest.fn<Promise<unknown>, [string, ...unknown[]]>();
jest.mock('../../src/ui/navigation/surfaces', () => ({
  openWithinOrPresent: (route: string, ...rest: unknown[]) => openWithinOrPresent(route, ...rest),
}));

// Avatar-set path is asserted, not exercised for real.
const updateProfileWithAvatar = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/ui/utils/avatarUtils', () => ({
  updateProfileWithAvatar: (...args: unknown[]) => updateProfileWithAvatar(...args),
}));

// Minimal core surface used by the hook (types are erased at runtime).
const updateAvatarVisibility = jest.fn().mockResolvedValue(undefined);
jest.mock('@oxy.so/core', () => ({
  translate: (_lang: string | undefined, key: string) => key,
  updateAvatarVisibility: (...args: unknown[]) => updateAvatarVisibility(...args),
}));

import { toast } from '@oxy.so/bloom';
import { useAvatarPicker } from '../../src/ui/hooks/useAvatarPicker';

const croppedResult = {
  uri: 'file:///cropped.jpg',
  width: 512,
  height: 512,
  mime: 'image/jpeg' as const,
};

const makeOxyServices = () => ({
  assetGetUrl: jest.fn().mockResolvedValue({ url: 'https://cdn.example/pic.png' }),
  assetUpload: jest.fn().mockResolvedValue({ id: 'uploaded-1' }),
});

const renderPicker = (oxyServices: ReturnType<typeof makeOxyServices>) =>
  renderHook(() =>
    useAvatarPicker({
      // Only the two async methods are touched by the hook.
      oxyServices: oxyServices as never,
      currentLanguage: 'en-US',
      activeSessionId: 'session-1',
      queryClient: {} as never,
    }),
  );

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useAvatarPicker', () => {
  it('presents ChangeAvatar and uploads the crop it resolves with', async () => {
    openWithinOrPresent.mockResolvedValue(croppedResult);
    const oxyServices = makeOxyServices();
    const { result } = renderPicker(oxyServices);

    await act(async () => {
      await result.current.openAvatarPicker();
    });

    // ONE flow — the source list and the cropper live inside it.
    expect(openWithinOrPresent).toHaveBeenCalledTimes(1);
    expect(openWithinOrPresent).toHaveBeenCalledWith('ChangeAvatar');

    expect(oxyServices.assetUpload).toHaveBeenCalledTimes(1);
    expect(updateAvatarVisibility).toHaveBeenCalledWith(
      'uploaded-1',
      expect.anything(),
      'useAvatarPicker',
    );
    expect(updateProfileWithAvatar).toHaveBeenCalledWith(
      { avatar: 'uploaded-1' },
      expect.anything(),
      'session-1',
      expect.anything(),
    );
    expect(toast.success).toHaveBeenCalled();
  });

  it('clears the avatar when the surface resolves with a removal', async () => {
    openWithinOrPresent.mockResolvedValue({ removed: true });
    const oxyServices = makeOxyServices();
    const { result } = renderPicker(oxyServices);

    await act(async () => {
      await result.current.openAvatarPicker();
    });

    // A removal writes an EMPTY avatar — it never uploads anything.
    expect(oxyServices.assetUpload).not.toHaveBeenCalled();
    expect(updateProfileWithAvatar).toHaveBeenCalledWith(
      { avatar: '' },
      expect.anything(),
      'session-1',
      expect.anything(),
    );
    expect(toast.success).toHaveBeenCalledWith('editProfile.toasts.avatarRemoved');
  });

  it('aborts when the surface is cancelled (no upload, no profile write)', async () => {
    openWithinOrPresent.mockResolvedValue(undefined);
    const oxyServices = makeOxyServices();
    const { result } = renderPicker(oxyServices);

    await act(async () => {
      await result.current.openAvatarPicker();
    });

    expect(openWithinOrPresent).toHaveBeenCalledTimes(1);
    expect(oxyServices.assetUpload).not.toHaveBeenCalled();
    expect(updateProfileWithAvatar).not.toHaveBeenCalled();
  });

  it('surfaces an error when the upload returns no file id', async () => {
    openWithinOrPresent.mockResolvedValue(croppedResult);
    const oxyServices = makeOxyServices();
    oxyServices.assetUpload.mockResolvedValue({});
    const { result } = renderPicker(oxyServices);

    await act(async () => {
      await result.current.openAvatarPicker();
    });

    expect(updateProfileWithAvatar).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it('surfaces an error when clearing the avatar fails', async () => {
    openWithinOrPresent.mockResolvedValue({ removed: true });
    updateProfileWithAvatar.mockRejectedValueOnce(new Error('network down'));
    const oxyServices = makeOxyServices();
    const { result } = renderPicker(oxyServices);

    await act(async () => {
      await result.current.openAvatarPicker();
    });

    expect(toast.error).toHaveBeenCalledWith('network down');
    expect(toast.success).not.toHaveBeenCalled();
  });
});
