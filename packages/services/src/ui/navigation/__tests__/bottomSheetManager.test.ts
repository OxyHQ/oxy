import { createSurfaceNavStack } from '../surfaceNavStack';
import { showBottomSheet, goBack } from '../bottomSheetManager';
import { presentRoute, topMorphableSurface } from '../surfaces';

jest.mock('../surfaces', () => ({
  presentRoute: jest.fn(),
  topMorphableSurface: jest.fn(),
  closeAllRouteSurfaces: jest.fn(),
}));

describe('imperative navigation preserves the visible surface history', () => {
  beforeEach(() => jest.clearAllMocks());

  it('morphs an open detached account menu and backs to it instead of presenting a new root', () => {
    const stack = createSurfaceNavStack('AccountDialog');
    jest
      .mocked(topMorphableSurface)
      .mockReturnValue({ navigate: stack.navigate, goBack: stack.goBack } as ReturnType<
        typeof topMorphableSurface
      >);
    showBottomSheet('ManageAccount');
    expect(presentRoute).not.toHaveBeenCalled();
    expect(stack.getTop().route).toBe('ManageAccount');
    expect(stack.canGoBack()).toBe(true);
    expect(goBack()).toBe(true);
    expect(stack.getTop().route).toBe('AccountDialog');
    expect(goBack()).toBe(false);
    expect(stack.store.getState().closing).toBe(false);
  });

  it('opens a root only when there is no existing surface', () => {
    jest.mocked(topMorphableSurface).mockReturnValue(undefined);
    showBottomSheet('HelpSupport');
    expect(presentRoute).toHaveBeenCalledWith('HelpSupport', {});
    expect(goBack()).toBe(false);
  });
});
