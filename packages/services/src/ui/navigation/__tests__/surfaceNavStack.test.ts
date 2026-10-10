import { createSurfaceNavStack } from '../surfaceNavStack';
import {
  __resetSurfaceBackBridgeForTests,
  pushSurfaceBackHandler,
  __invokeTopSurfaceBackForTests,
} from '../surfaceBackBridge';

describe('createSurfaceNavStack', () => {
  it('starts with a single root frame', () => {
    const stack = createSurfaceNavStack('ManageAccount', { foo: 1 });
    expect(stack.getTop().route).toBe('ManageAccount');
    expect(stack.getTop().props).toEqual({ foo: 1 });
    expect(stack.canGoBack()).toBe(false);
  });

  it('navigate pushes frames and goBack pops them', () => {
    const stack = createSurfaceNavStack('ManageAccount');
    stack.navigate('EditProfile', { userId: 'u1' });
    expect(stack.getTop().route).toBe('EditProfile');
    expect(stack.canGoBack()).toBe(true);
    expect(stack.goBack()).toBe(true);
    expect(stack.getTop().route).toBe('ManageAccount');
    expect(stack.goBack()).toBe(false);
  });

  it('replace swaps the top frame without growing history', () => {
    const stack = createSurfaceNavStack('ManageAccount');
    stack.navigate('EditProfile');
    stack.replace('PrivacySettings');
    expect(stack.getTop().route).toBe('PrivacySettings');
    expect(stack.goBack()).toBe(true);
    expect(stack.getTop().route).toBe('ManageAccount');
  });

  it('tracks wizard steps on the current frame', () => {
    const stack = createSurfaceNavStack('EditProfile', { initialStep: 2 });
    expect(stack.getTop().step).toBe(2);
    expect(stack.canGoBack()).toBe(true);
    stack.setStep(1);
    expect(stack.getTop().step).toBe(1);
  });

  it('requestDismiss flips closing once', () => {
    const stack = createSurfaceNavStack('ManageAccount');
    stack.requestDismiss('done');
    expect(stack.store.getState().closing).toBe(true);
    expect(stack.store.getState().closeResult).toBe('done');
    stack.requestDismiss('again');
    expect(stack.store.getState().closeResult).toBe('done');
  });

  describe('result-bearing sub-flow (morphed-in avatar flow)', () => {
    it('resolves with the descendant dismiss result and pops back to the caller frame', async () => {
      // Device / camera path: ChangeAvatar navigates straight to the cropper.
      const stack = createSurfaceNavStack('EditProfile');
      const flow = stack.beginFlow('ChangeAvatar');
      expect(stack.getTop().route).toBe('ChangeAvatar');
      // Drill into the crop editor within the flow, then confirm.
      stack.navigate('AvatarCrop', { imageUri: 'file:///x.jpg' });
      stack.resolveFlowOrDismiss({ uri: 'file:///cropped.jpg' });
      await expect(flow).resolves.toEqual({ uri: 'file:///cropped.jpg' });
      // Popped back to the frame that started the flow — surface NOT dismissed.
      expect(stack.getTop().route).toBe('EditProfile');
      expect(stack.store.getState().closing).toBe(false);
    });

    it('resolves undefined when the flow entry frame is backed out of', async () => {
      const stack = createSurfaceNavStack('EditProfile');
      const flow = stack.beginFlow('ChangeAvatar');
      stack.navigate('AvatarCrop');
      expect(stack.goBack()).toBe(true); // crop -> list (still in flow)
      expect(stack.goBack()).toBe(true); // list -> EditProfile (cancels flow)
      await expect(flow).resolves.toBeUndefined();
      expect(stack.getTop().route).toBe('EditProfile');
      expect(stack.store.getState().closing).toBe(false);
    });

    it('resolveFlowOrDismiss with NO active flow dismisses the surface (cold present)', () => {
      const stack = createSurfaceNavStack('ChangeAvatar');
      stack.resolveFlowOrDismiss({ removed: true });
      expect(stack.store.getState().closing).toBe(true);
      expect(stack.store.getState().closeResult).toEqual({ removed: true });
    });

    it('abandons a pending flow (undefined) when the surface is torn down', async () => {
      const stack = createSurfaceNavStack('EditProfile');
      const flow = stack.beginFlow('ChangeAvatar');
      stack.abandonActiveFlow();
      await expect(flow).resolves.toBeUndefined();
    });

    it('My Oxy files: the picker and cropper are FORWARD frames; the cropper confirm resolves the flow', async () => {
      // EditProfile → (flow) ChangeAvatar → FileManagement picker → AvatarCrop, all
      // plain forward frames in the ONE avatar flow. Selecting a file forward-
      // navigates to the cropper (it does NOT resolve the flow); the cropper's
      // confirm resolves the flow and pops all the way back to EditProfile.
      const stack = createSurfaceNavStack('EditProfile');
      const flow = stack.beginFlow('ChangeAvatar');
      stack.navigate('FileManagement', { selectMode: true }); // "My Oxy files" picker
      stack.navigate('AvatarCrop', { imageFileId: 'file-1' }); // forward-nav on pick
      stack.resolveFlowOrDismiss({ uri: 'file:///cropped.jpg' }); // cropper confirm
      await expect(flow).resolves.toEqual({ uri: 'file:///cropped.jpg' });
      expect(stack.getTop().route).toBe('EditProfile');
      expect(stack.store.getState().closing).toBe(false);
    });

    it('My Oxy files: Back unwinds cropper → picker → list, then cancels the flow', async () => {
      // The bug this fixes: Back from the cropper must return to the PICKER (re-pick),
      // not straight to the ChangeAvatar list.
      const stack = createSurfaceNavStack('EditProfile');
      const flow = stack.beginFlow('ChangeAvatar');
      stack.navigate('FileManagement', { selectMode: true });
      stack.navigate('AvatarCrop', { imageFileId: 'file-1' });
      expect(stack.goBack()).toBe(true); // crop -> picker (re-pick)
      expect(stack.getTop().route).toBe('FileManagement');
      expect(stack.goBack()).toBe(true); // picker -> ChangeAvatar
      expect(stack.getTop().route).toBe('ChangeAvatar');
      expect(stack.goBack()).toBe(true); // ChangeAvatar -> EditProfile (cancels flow)
      await expect(flow).resolves.toBeUndefined();
      expect(stack.getTop().route).toBe('EditProfile');
      expect(stack.store.getState().closing).toBe(false);
    });

    // The stack still supports NESTED flows generically, even though no current
    // caller opens a flow inside another (the avatar flow uses one flow + forward
    // frames). These guard that capability.
    it('supports NESTED flows: the inner flow resolves first, then the outer one', async () => {
      const stack = createSurfaceNavStack('EditProfile');
      const outer = stack.beginFlow('ChangeAvatar');
      const inner = stack.beginFlow('FileManagement');
      expect(stack.getTop().route).toBe('FileManagement');
      stack.resolveFlowOrDismiss({ id: 'file-1' });
      await expect(inner).resolves.toEqual({ id: 'file-1' });
      expect(stack.getTop().route).toBe('ChangeAvatar');
      expect(stack.store.getState().closing).toBe(false);
      stack.navigate('AvatarCrop');
      stack.resolveFlowOrDismiss({ uri: 'file:///c.jpg' });
      await expect(outer).resolves.toEqual({ uri: 'file:///c.jpg' });
      expect(stack.getTop().route).toBe('EditProfile');
    });

    it('backing out of a NESTED inner flow leaves the outer flow pending', async () => {
      const stack = createSurfaceNavStack('EditProfile');
      const outer = stack.beginFlow('ChangeAvatar');
      const inner = stack.beginFlow('FileManagement');
      expect(stack.goBack()).toBe(true); // inner entry backed out -> cancels inner only
      await expect(inner).resolves.toBeUndefined();
      expect(stack.getTop().route).toBe('ChangeAvatar');
      let outerSettled = false;
      void outer.then(() => {
        outerSettled = true;
      });
      await Promise.resolve();
      expect(outerSettled).toBe(false);
    });

    it('tearing down the surface abandons ALL pending flows (undefined)', async () => {
      const stack = createSurfaceNavStack('EditProfile');
      const outer = stack.beginFlow('ChangeAvatar');
      const inner = stack.beginFlow('FileManagement');
      stack.abandonActiveFlow();
      await expect(inner).resolves.toBeUndefined();
      await expect(outer).resolves.toBeUndefined();
    });
  });
});

describe('pushSurfaceBackHandler', () => {
  afterEach(() => {
    __resetSurfaceBackBridgeForTests();
  });

  it('delegates to the topmost handler', () => {
    const calls: string[] = [];
    pushSurfaceBackHandler(() => {
      calls.push('bottom');
      return true;
    });
    pushSurfaceBackHandler(() => {
      calls.push('top');
      return true;
    });

    expect(__invokeTopSurfaceBackForTests()).toBe(true);
    expect(calls).toEqual(['top']);
  });
});
