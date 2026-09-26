import { getSurfaceConfig, getSurfacePresentation } from '../surfaceRegistry';

/**
 * `getSurfaceConfig` resolves how a route renders. EVERY route is a responsive
 * `'sheet'` that MORPHS in place; NO route stacks (genuine overlays are Bloom-raw
 * calls outside this registry). The flagship image picker is a sheet that owns its
 * own scrolling + chrome. These guard the routing contract.
 */
describe('getSurfaceConfig presentation', () => {
    const imageOnlyPickerProps = {
        selectMode: true,
        disabledMimeTypes: ['video/', 'audio/', 'application/pdf'],
    };

    it('defaults every route to the responsive sheet', () => {
        expect(getSurfaceConfig('ManageAccount', {}).presentation).toBe('sheet');
        expect(getSurfaceConfig('AvatarCrop', {}).presentation).toBe('sheet');
        expect(getSurfacePresentation('ManageAccount', {})).toBe('sheet');
    });

    it('renders the FileManagement image-only picker as a morphing own-scroller sheet', () => {
        const config = getSurfaceConfig('FileManagement', imageOnlyPickerProps);
        // It morphs in place like every screen — a sheet, not a stacked full-bleed.
        expect(config.presentation).toBe('sheet');
        expect(config.stacks).toBe(false);
        // PhotoPickerView owns its own FlatList → the host must not wrap it in a
        // ScrollView. It now renders the SHARED Dialog nav header (Cancel / title /
        // Upload) like every other screen — its bespoke bar is gone.
        expect(config.scrollable).toBe(false);
        expect(config.header).toBe(true);
        // …and it grows to the large morph target so the grid has room.
        expect(config.frameSize).toEqual({ heightRatio: 0.9, maxWidth: 640 });
    });

    it('morphs the surface for every route, the picker included', () => {
        // NAV-WITHIN: drilling into these swaps the content inside ONE surface,
        // which reshapes the panel instead of hard-cutting.
        expect(getSurfaceConfig('ManageAccount', {}).morph).toBe(true);
        expect(getSurfaceConfig('TrustFAQ', {}).morph).toBe(true);
        expect(getSurfaceConfig('FollowersList', {}).morph).toBe(true);
        expect(getSurfaceConfig('FileManagement', imageOnlyPickerProps).morph).toBe(true);
    });

    it('never stacks any route — every screen morphs in place', () => {
        // `stacks` is the DECLARATIVE morph-vs-stack signal, and it is FALSE for
        // every route: overlays (action sheets / confirm / prompt) are Bloom-raw
        // `surfaces.present`/`confirm` calls outside this registry.
        expect(getSurfaceConfig('ManageAccount', {}).stacks).toBe(false);
        expect(getSurfaceConfig('AvatarCrop', {}).stacks).toBe(false);
        expect(getSurfaceConfig('ChangeAvatar', {}).stacks).toBe(false);
        expect(getSurfaceConfig('AccountDialog', {}).stacks).toBe(false);
        expect(getSurfaceConfig('FileManagement', imageOnlyPickerProps).stacks).toBe(false);
        expect(getSurfaceConfig('FileManagement', {}).stacks).toBe(false);
    });

    it('lets the avatar flow morph list → crop inside ONE surface', () => {
        // ChangeAvatar navigates WITHIN its surface to AvatarCrop, so both frames
        // must share a presentation (else the crop would open on top instead of
        // morphing) and both must opt IN to the morph.
        const list = getSurfaceConfig('ChangeAvatar', {});
        const crop = getSurfaceConfig('AvatarCrop', {});
        expect(crop.presentation).toBe(list.presentation);
        expect(list.morph).toBe(true);
        expect(crop.morph).toBe(true);
        // The morph can only RESIZE the panel when the Dialog owns the scroll
        // container — an own-scroller surface cross-fades but never reshapes.
        expect(list.scrollable).toBe(true);
        expect(crop.scrollable).toBe(true);
    });

    it('gives the avatar flow the Dialog nav header on both frames', () => {
        // The Dialog's `header` is fixed for a surface's whole life, so a
        // headerless crop frame inside a header-mode surface would stack two
        // bars. Both frames declare their chrome through `useSurfaceHeader`.
        expect(getSurfaceConfig('ChangeAvatar', {}).header).toBe(true);
        expect(getSurfaceConfig('AvatarCrop', {}).header).toBe(true);
    });

    it('renders the shared nav header on every route — nothing is headerless', () => {
        // The whole SDK UI is unified on the Dialog nav header. The last four
        // holdouts (Profile / PaymentGateway / WelcomeNewUser + the image picker)
        // now declare their chrome through `useSurfaceHeader` like every screen.
        expect(getSurfaceConfig('Profile', {}).header).toBe(true);
        expect(getSurfaceConfig('PaymentGateway', {}).header).toBe(true);
        expect(getSurfaceConfig('WelcomeNewUser', {}).header).toBe(true);
        expect(getSurfaceConfig('ManageAccount', {}).header).toBe(true);
        expect(getSurfaceConfig('FileManagement', imageOnlyPickerProps).header).toBe(true);
    });

    it('keeps FileManagement on the sheet when it is not an image-only picker', () => {
        // Browse mode (no selectMode) — the standard file manager.
        expect(getSurfaceConfig('FileManagement', {}).presentation).toBe('sheet');
        // Select mode that still allows non-image types is not the flagship picker.
        expect(
            getSurfaceConfig('FileManagement', {
                selectMode: true,
                disabledMimeTypes: ['video/'],
            }).presentation,
        ).toBe('sheet');
    });
});
